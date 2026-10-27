/**
 * The MCP server: one `McpServer` per connection, one browser session behind it.
 *
 * This is the assembly point. `createSession` gives a connection its browser (its own profile, its own
 * DevTools connection, its own tabs), `createServer` registers the tools on it, and `serveStdio`
 * puts the pair on the protocol. The HTTP transport in `./http.js` creates one such pair per MCP
 * session, so two agents using one HTTP endpoint still never share a page by accident.
 *
 * @module browser-use-mcp/server
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { join } from 'node:path'

import { packageInfo } from './cli.js'
import { ensureEngine, reportText } from './engine.js'
import { GUIDANCE, ONE_CONNECTION, registerTools, toolNames } from './tools.js'
import { BrowserSession } from './session.js'

/** The identity this server reports to MCP clients. */
export const SERVER_NAME = 'browser-use-mcp'
/** This package's own version, read from its manifest once. */
export const VERSION = packageInfo().version

/**
 * The instructions an MCP client adds to its model's context before the tools are used.
 *
 * It is the same rules the tool descriptions carry, said once for the whole surface: without it a
 * model reads "browser_open returns a table" as documentation, not as the action grammar it is.
 * @param {object} config - the resolved configuration.
 */
export function instructions(config) {
  const jev = config.jev.enabled
    ? 'The Jev policy is on: when a step is easier to describe than to pick, call browser_act with an intent and no operation, and the policy chooses the operation and target on that observation. A TYPE_TEXT with an intent and no text gets its value from the text model. Either spends model quota, and a policy choice is a claim like any other: check its effect in the observation it returns.'
    : 'The policy is off (--no-jev): browser_goal is not offered and browser_act has no intent parameter, so name the operation, target and text yourself.'
  return `${GUIDANCE}

${ONE_CONNECTION}

${jev}

One MCP session owns one browser. If two agents need their own pages at the same time, run one server per agent (stdio does this naturally) or use the HTTP transport, which gives every MCP session its own browser. The browser stays open across calls; browser_close closes the tab, and the server closes the browser when the connection ends.`
}

/** A client-chosen profile name from `?profile=` or `X-Browser-Use-Profile`. */
export const PROFILE_PARAMETER = /^[A-Za-z0-9_-]{1,32}$/u

/** Whether a client-supplied profile name is one directory-safe segment. */
export function validProfileName(name) {
  return typeof name === 'string' && PROFILE_PARAMETER.test(name)
}

/** The label one session's browser uses: stable, filesystem-safe, and unique per MCP session. */
export function sessionLabel(config, suffix) {
  const base = config.profile.replace(/[^A-Za-z0-9_-]/gu, '') || 'profile'
  if (!suffix) return base
  const tail = String(suffix).replace(/[^A-Za-z0-9]/gu, '').slice(0, 12) || 'session'
  return `${base}-${tail}`
}

/**
 * One browser session for one MCP connection.
 *
 * A suffix makes the session's profile unique, which is what lets an HTTP endpoint serve several
 * agents at once without two of them launching on one Chrome profile. A client-chosen profile name
 * (`profileName`) is the opposite: the directory is stable across reconnects, so an agent that names
 * itself keeps its logins — and two agents that name themselves the same way are refused by the
 * profile lock rather than silently sharing a browser.
 * @param {object} config - the resolved configuration.
 * @param {object} [options]
 * @param {string} [options.suffix] - a unique per-session suffix for the profile directory.
 * @param {string} [options.profileName] - a client-chosen, stable profile name (HTTP only).
 * @param {object} [options.logger] - the stderr logger.
 */
export function createSession(config, { suffix, profileName, logger } = {}) {
  const named = profileName !== undefined && profileName !== null && profileName !== ''
  const label = named ? `${sessionLabel(config)}-${profileName}` : sessionLabel(config, suffix)
  const directory = join(config.browserUseMcpHome, 'profiles', label)
  const session = new BrowserSession({
    config,
    label,
    logger,
    connection: named || suffix !== undefined ? { userDataDir: directory } : {},
  })
  // The HTTP transport decides what to do with the profile directory when the session ends: a
  // client-chosen one is kept (that is the point of naming it), an anonymous one is removed.
  session.profile = { label, directory, persistent: named }
  return session
}

/**
 * One MCP server with the browser tools registered.
 * @param {object} options
 * @param {object} options.config - the resolved configuration.
 * @param {import('./session.js').BrowserSession} options.session - the session the tools drive.
 * @param {object} [options.logger] - the stderr logger.
 */
export function createServer({ config, session, logger }) {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION, title: 'browser-use-mcp' },
    { instructions: instructions(config) },
  )
  registerTools(server, { config, session, logger, version: VERSION })
  return server
}

/**
 * Build the engine environment in the background so the first browser call does not have to wait for
 * it — and say so on stderr, never on the protocol's stdout.
 *
 * A failure here is not fatal: the browser tools report the same problems, with their fixes, when
 * they are called. The point is that the install a machine needs once happens while the agent is
 * still reading its instructions rather than inside its first click.
 */
export function prewarm(config, logger) {
  const started = Date.now()
  logger?.info(`checking the browser engine (state root ${config.browserUseMcpHome})`)
  ensureEngine(config, { onOutput: line => logger?.debug?.(`install: ${line}`) })
    .then(report => {
      if (report.ok) {
        logger?.info(`browser engine ready: jev_ultrafast ${report.engine.engine}, browser-harness ${report.engine.browserHarness} (Python ${report.engine.python})`)
        return
      }
      logger?.error(`the browser engine is not ready yet (${Math.round((Date.now() - started) / 1000)}s):\n${reportText(report)}`)
    })
    .catch(error => logger?.error(`checking the browser engine failed: ${error?.stack ?? error}`))
}

/**
 * Serve one MCP connection over stdio until the client closes stdin or the process is signalled.
 *
 * @param {object} config - the resolved configuration.
 * @param {object} logger - the stderr logger.
 * @returns {Promise<{server: McpServer, session: BrowserSession, shutdown: (reason: string) => Promise<void>}>}
 */
export async function serveStdio(config, logger) {
  const session = createSession(config, { logger })
  const server = createServer({ config, session, logger })
  let stopping = false
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })

  const shutdown = async reason => {
    if (stopping) return
    stopping = true
    const began = Date.now()
    logger?.info(`shutting down (${reason})`)
    // Synchronously, before anything can go wrong: the profile claim is released even if this
    // process is killed while the browser is still stopping.
    session.releaseLocks()
    // A stdio MCP client closes the pipe, waits two seconds, sends SIGTERM, waits two more, and then
    // kills. The engine's daemon cleanup can outlast that, so the launch is bounded and the process
    // exits on its own terms instead of being killed mid-cleanup.
    const forced = setTimeout(() => {
      logger?.error('shutdown took too long; exiting with the browser already asked to stop')
      session.releaseLocks()
      process.exit(0)
    }, 3_000)
    forced.unref?.()
    try {
      await server.close()
      logger?.debug?.(`MCP server closed in ${Date.now() - began}ms`)
    } catch (error) {
      logger?.debug?.(`closing the MCP server failed: ${error?.message ?? error}`)
    }
    try {
      const problem = await session.shutdown({ graceMs: 1_200 })
      logger?.debug?.(`browser session shut down in ${Date.now() - began}ms`)
      if (problem !== '') logger?.error(`the browser was not shut down cleanly: ${problem}`)
    } catch (error) {
      logger?.error(`stopping the browser failed: ${error?.stack ?? error}`)
    }
    clearTimeout(forced)
    resolveClosed()
    // Nothing else holds this process open on purpose; the sidecar child is gone and stdin is closed.
    process.exit(0)
  }

  process.once('exit', () => session.releaseLocks())
  const transport = new StdioServerTransport()
  // The transport reads stdin but does not treat its end as a close: an MCP client that exits would
  // otherwise leave this process — and the Chrome it launched — running with no one to answer.
  process.stdin.once('end', () => { shutdown('stdin closed') })
  process.once('SIGINT', () => { shutdown('SIGINT') })
  process.once('SIGTERM', () => { shutdown('SIGTERM') })
  process.once('SIGHUP', () => { shutdown('SIGHUP') })
  await server.connect(transport)
  prewarm(config, logger)
  logger?.info(`serving MCP on stdio: ${toolNames(config).length} tools, ${config.mode} mode, transport stdio`)
  await closed
  return { server, session, shutdown }
}
