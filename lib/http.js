/**
 * Streamable HTTP: one endpoint, one browser per MCP session.
 *
 * Useful when several agents should call one long-running server instead of each launching its own
 * stdio process. Each MCP session (its own `initialize`) still gets its own browser session — its own
 * profile directory, its own DevTools connection, its own tab — so two agents never click on one
 * page by accident. A session that stops talking for a while is closed, tab and browser included, so
 * an abandoned client does not leave a Chrome running forever.
 *
 * The transport itself is the official SDK's, stateful mode; this module owns the routing, the
 * per-session lifecycle, and nothing about the protocol.
 *
 * @module browser-use-mcp/http
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join, sep } from 'node:path'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createServer, createSession } from './server.js'

/**
 * Serve the MCP protocol over Streamable HTTP until the process is signalled.
 *
 * @param {object} config - the resolved configuration.
 * @param {object} logger - the stderr logger.
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function serveHttp(config, logger) {
  const entries = new Map()
  const idleMs = config.httpIdleMs
  let closing = false
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })

  const dispose = async (sessionId, reason) => {
    const entry = entries.get(sessionId)
    if (entry === undefined) return
    entries.delete(sessionId)
    logger?.info(`MCP session ${sessionId.slice(0, 8)} closed (${reason}); closing its browser`)
    try {
      await entry.server.close()
    } catch (error) {
      logger?.debug?.(`closing the MCP session failed: ${error?.message ?? error}`)
    }
    try {
      const problem = await entry.session.shutdown()
      if (problem !== '') logger?.error(`a browser was not shut down cleanly: ${problem}`)
    } catch (error) {
      logger?.error(`stopping a browser failed: ${error?.stack ?? error}`)
    }
    // An HTTP session is ephemeral: its client cannot come back to the same profile (the session id
    // is random), so the profile directory would otherwise accumulate one Chrome profile per agent.
    const profileDir = entry.session.connection.userDataDir
    const managed = join(config.browserUseMcpHome, 'profiles') + sep
    if (profileDir.startsWith(managed)) {
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch (error) {
        logger?.debug?.(`removing ${profileDir} failed: ${error?.message ?? error}`)
      }
    }
  }

  const http = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (url.pathname !== config.path) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(`Not found. MCP is served at ${config.path}\n`)
        return
      }
      const header = request.headers['mcp-session-id']
      const knownId = Array.isArray(header) ? header[0] : header
      if (knownId !== undefined && knownId !== '') {
        const entry = entries.get(knownId)
        if (entry === undefined) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Unknown or expired MCP session. Send initialize again.\n')
          return
        }
        entry.lastSeen = Date.now()
        // A long POST (a browser launch, a goal run) sends no further request while it runs; counting
        // it in flight keeps the idle sweep from closing the session under its own answer. A GET is
        // the long-lived server-to-client stream by design and must not count, or a client that keeps
        // one open would never look idle.
        const counted = request.method === 'POST'
        if (counted) entry.inFlight += 1
        try {
          await entry.transport.handleRequest(request, response)
        } finally {
          if (counted) entry.inFlight -= 1
          entry.lastSeen = Date.now()
        }
        return
      }
      if (request.method !== 'POST') {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Send an MCP initialize request with POST first.\n')
        return
      }
      // A new MCP session: its own browser session, its own profile, its own sidecar.
      const sessionId = randomUUID()
      const session = createSession(config, { suffix: sessionId, logger })
      const server = createServer({ config, session, logger })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: initialized => {
          entries.set(initialized, { transport, server, session, lastSeen: Date.now(), inFlight: 0 })
          logger?.info(`MCP session ${initialized.slice(0, 8)} started (${entries.size} live)`)
        },
        onsessionclosed: initialized => {
          void dispose(initialized, 'the client closed the session')
        },
        // Plain JSON answers keep a simple agent's HTTP client working; an SSE-capable client still
        // gets its standalone stream on GET, which the transport serves itself.
        enableJsonResponse: true,
      })
      transport.onclose = () => {
        if (!closing) void dispose(sessionId, 'transport closed')
      }
      await server.connect(transport)
      await transport.handleRequest(request, response)
    } catch (error) {
      logger?.error(`an HTTP request failed: ${error?.stack ?? error}`)
      try {
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        }
        response.end('Internal server error\n')
      } catch {
        // The connection is already gone; nothing left to answer.
      }
    }
  })

  http.on('clientError', (error, socket) => {
    logger?.debug?.(`an HTTP client connection failed: ${error.message}`)
    socket.destroy()
  })

  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(config.port, config.host, () => {
      http.off('error', reject)
      resolve()
    })
  })

  const shown = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  const url = `http://${shown}:${config.port}${config.path}`
  const tools = await import('./tools.js')
  logger?.info(`serving MCP over Streamable HTTP at ${url}`)
  const idleText = idleMs < 60_000 ? `${(idleMs / 1000).toFixed(idleMs % 1000 === 0 ? 0 : 1)} seconds` : `${Math.round(idleMs / 60_000)} minutes`
  logger?.info(`${tools.toolNames(config).length} tools per session; each MCP session gets its own browser; idle sessions close after ${idleText}`)
  if (config.host !== '127.0.0.1' && config.host !== '::1' && config.host !== 'localhost') {
    logger?.error(
      `the HTTP endpoint is bound to ${config.host}: it has no authentication. Use it only on a trusted `
      + 'network, or bind --host 127.0.0.1 and reach it through a tunnel you control.',
    )
  }

  // Sweep often enough that a short test timeout behaves, and never more than once a minute.
  const sweepEvery = Math.min(60_000, Math.max(1_000, Math.floor(idleMs / 4)))
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [sessionId, entry] of entries) {
      if (entry.inFlight > 0) continue
      if (now - entry.lastSeen > idleMs) void dispose(sessionId, 'idle timeout')
    }
  }, sweepEvery)
  sweep.unref?.()

  const shutdown = async reason => {
    if (closing) return
    closing = true
    clearInterval(sweep)
    logger?.info(`shutting down the HTTP endpoint (${reason})`)
    // Stop accepting first, close every session's transport (which ends its SSE streams), and only
    // then force the sockets shut: a client that never comes back must not keep the process alive
    // after SIGTERM, which is exactly what an open event stream would otherwise do.
    const closed = new Promise(resolve => http.close(() => resolve()))
    await Promise.allSettled([...entries.keys()].map(sessionId => dispose(sessionId, reason)))
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1_500))])
    http.closeIdleConnections?.()
    http.closeAllConnections?.()
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1_500))])
    resolveClosed()
  }

  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGHUP', () => { void shutdown('SIGHUP') })

  await closed
  return { url, close: async () => shutdown('closed') }
}
