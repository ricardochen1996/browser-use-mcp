#!/usr/bin/env node
/**
 * `browser-use-mcp` — the executable.
 *
 * One command line, then one of three things: serve MCP (stdio by default, Streamable HTTP on
 * request), print the doctor's self-check, or build the managed Python environment. Only the last two
 * and `--help/--version` write to stdout; while serving MCP, stdout is the protocol and every log
 * line goes to stderr.
 */

import { ConfigError, resolveConfig } from '../lib/config.js'
import { packageInfo, parseCommandLine, USAGE } from '../lib/cli.js'
import { doctorReport } from '../lib/doctor.js'
import { ensureEngine, reportText } from '../lib/engine.js'
import { serveHttp } from '../lib/http.js'
import { createLogger } from '../lib/log.js'
import { serveStdio } from '../lib/server.js'
import { toolNames } from '../lib/tools.js'

const info = packageInfo()

/** CLI output; never called while MCP is being served. */
function print(line) {
  process.stdout.write(`${line}\n`)
}

/** Run one command line and return the process exit code. */
async function main(argv) {
  const parsed = parseCommandLine(argv)
  if (parsed.help) {
    print(USAGE)
    return 0
  }
  if (parsed.version) {
    print(info.version)
    return 0
  }
  const config = resolveConfig({ command: parsed.command, flags: parsed.flags })
  const logger = createLogger(config.logLevel)

  if (config.command === 'install') {
    logger.info(`building the browser engine environment in ${config.browserUseMcpHome}`)
    const report = await ensureEngine(config, {
      install: true,
      fresh: true,
      onOutput: line => logger.info(line),
    })
    print(reportText(report))
    return report.ok ? 0 : 1
  }

  if (config.command === 'doctor') {
    const result = await doctorReport({ config, tools: toolNames(config), version: info.version, fresh: true })
    print(result.text)
    return result.ok ? 0 : 1
  }

  if (config.transport === 'stdio') {
    await serveStdio(config, logger)
    return 0
  }
  await serveHttp(config, logger)
  return 0
}

// An unhandled rejection must not vanish: the browser is a child process, and a silent one is how a
// tool call "hangs" with no explanation. It is logged to stderr (stdout is the protocol) and the
// server keeps serving — a rejected background task is not a reason to drop every other connection.
process.on('unhandledRejection', error => {
  process.stderr.write(`browser-use-mcp unhandled rejection: ${error?.stack ?? error}\n`)
})

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`browser-use-mcp: configuration error: ${error.message}\n`)
    process.exitCode = 2
  } else {
    process.stderr.write(`browser-use-mcp: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  }
}
