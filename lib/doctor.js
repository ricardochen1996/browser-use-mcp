/**
 * The doctor: everything a person should know before the first browser call, in one report.
 *
 * It only looks — `install` is a separate command — so calling it never builds an environment or
 * opens a page. The same function backs `browser_doctor` (so an agent can diagnose itself) and
 * `browser-use-mcp doctor` (so a terminal can, before any MCP client is configured).
 *
 * @module browser-use-mcp/doctor
 */

import { describeConfig } from './config.js'
import { inspectEngine, reportText } from './engine.js'
import { jevDescribe, jevReadiness } from './jev.js'

/** One line about the live session: what it has open, or that it is idle. */
function sessionLine(session) {
  if (!session) return 'idle (this transport has no browser session yet)'
  const status = session.status()
  if (status.page) {
    return `page ${status.page.title ? `${status.page.title} — ` : ''}${status.page.url} (observation ${status.page.observation})`
      + `${status.lastAction ? `, last action: ${status.lastAction}` : ''}${status.sidecarRunning ? '' : ', browser not running'}`
  }
  if (status.problem) return `no page open; the last browser was not shut down cleanly (${status.problem})`
  return 'idle (no page has been opened by this session)'
}

/**
 * The full self-check report.
 *
 * @param {object} options
 * @param {object} options.config - the resolved configuration.
 * @param {import('./session.js').BrowserSession} [options.session] - the live session, if one exists.
 * @param {string[]} [options.tools] - the tool names this configuration offers.
 * @param {string} [options.version] - this package's version.
 * @param {boolean} [options.fresh] - probe again instead of reusing the remembered engine answer.
 * @returns {Promise<{text: string, ok: boolean, report: object}>} the report and whether it is ready.
 */
export async function doctorReport({ config, session, tools = [], version = '', fresh = false } = {}) {
  const report = await inspectEngine(config, { fresh })
  const lines = []
  lines.push(`browser-use-mcp${version ? ` v${version}` : ''} — self-check (Node ${process.version}, ${process.platform}-${process.arch})`)
  lines.push('')
  // The configuration lines, except the Jev one: the doctor can say more than "on/off" — whether a
  // model call could actually run — and one subject deserves one line.
  for (const line of describeConfig(config)) {
    if (!line.startsWith('Jev')) lines.push(line)
  }
  const readiness = jevReadiness(config)
  lines.push(`Jev     : ${jevDescribe(config)}${readiness.ready ? '' : ` — NOT READY: ${readiness.description}`}`)
  lines.push(`Tools   : ${tools.length === 0 ? '(none)' : tools.join(', ')}`)
  lines.push(`Session : ${sessionLine(session)}`)
  lines.push('')
  lines.push(reportText(report, {}))
  return { text: lines.join('\n'), ok: report.ok, report }
}

/** The doctor report as the CLI prints it; the same text, with the problems it found. */
export async function doctorFromCli({ config, version, log }) {
  const result = await doctorReport({ config, version, fresh: true })
  log?.info?.(`checking the browser engine at ${config.browserUseMcpHome}`)
  return result
}
