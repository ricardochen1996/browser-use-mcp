/**
 * Logging for a protocol whose stdout belongs to the transport.
 *
 * An MCP stdio server's stdout carries JSON-RPC frames, so every log line here goes to stderr.
 * A line that landed on stdout would corrupt the protocol rather than merely spoil the output.
 *
 * @module browser-use-mcp/log
 */

const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 }
const PREFIX = 'browser-use-mcp'

/** One stderr logger bound to a level; `debug` is silent unless the level asks for it. */
export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info
  const write = (kind, args) => {
    if (threshold < LEVELS[kind]) return
    const text = args
      .map(value => (value instanceof Error ? (value.stack ?? value.message) : typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ')
    process.stderr.write(`${PREFIX} ${text}\n`)
  }
  return {
    level,
    error: (...args) => write('error', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
  }
}

/** A logger that throws everything away, for library callers and tests. */
export const silentLogger = createLogger('silent')
