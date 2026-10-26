/**
 * The command line: `serve` (the default), `doctor`, `install`.
 *
 * Words become flags here and nothing else: validation and resolution live in `./config.js`, so the
 * same rules apply whether a value came from the command line, an MCP client's `env` block, or the
 * shell the server was started from.
 *
 * @module browser-use-mcp/cli
 */

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

/** The value of the package's own manifest, read once. */
export function packageInfo() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  return { name: manifest.name, version: manifest.version, description: manifest.description }
}

export const COMMANDS = ['serve', 'doctor', 'install']

export const USAGE = `browser-use-mcp — an MCP server that gives any agent a browser it can see and click

Usage:
  browser-use-mcp [serve] [options]   speak MCP on stdio (default) or Streamable HTTP
  browser-use-mcp doctor  [options]   check interpreter, engine, browser and configuration
  browser-use-mcp install [options]   build the managed Python environment now

Options (each can also come from the environment; a flag wins over it):
  --transport <stdio|http>       transport to serve (default: stdio)
  --host <addr>                  HTTP bind address (default: 127.0.0.1)
  --port <number>                HTTP port (default: 7331)
  --path <route>                 HTTP route (default: /mcp)
  --mode <launch|attach>         launch a browser this server owns, or drive a running one
  --cdp-endpoint <url>           DevTools endpoint for attach mode (http(s) or ws(s))
  --executable <path>            browser to launch (default: Chrome/Chromium)
  --profile <name>               profile directory name under the state root (default: default)
  --user-data-dir <path>         launch this profile directory instead of the managed one
  --headless                     launch without a visible window
  --headed                       show the window (overrides a headless environment)
  --python <path>                use this Python 3.12+ interpreter instead of a managed one
  --home <dir>                   state root (default: ~/.browser-use-mcp)
  --no-eval                      do not offer browser_eval
  --no-screenshots               do not offer browser_screenshot
  --no-jev                       do not offer browser_goal or browser_act's intent
  --jev-decider <typesafe|chat>  who answers the policy's questions (default: typesafe)
  --typesafe-base-url <url>      TypeSafe endpoint      (env TYPESAFE_BASE_URL)
  --typesafe-model <name>        TypeSafe model         (env TYPESAFE_MODEL)
  --typesafe-api-key <key>       TypeSafe key           (env TYPESAFE_API_KEY)
  --text-model-base-url <url>    OpenAI-compatible endpoint (env TEXT_MODEL_BASE_URL)
  --text-model <name>            text model             (env TEXT_MODEL)
  --text-model-api-key <key>     text model key         (env TEXT_MODEL_API_KEY)
  --text-model-reasoning <mode>  none | thinking-disabled (env TEXT_MODEL_REASONING)
  --request-timeout-ms <number>  longest single browser request (default: 180000)
  --log-level <silent|error|info|debug>  stderr logging (default: info)
  -h, --help                     show this help
  -v, --version                  show the version

A Jev key is only needed for browser_goal and browser_act's intent; the rest of the tools never
spend model quota. With --jev-decider chat the text model decides instead, so set the TEXT_MODEL_*
variables and no TypeSafe key is needed.
`

/** The option table: names are the long form, the values are `node:util` parseArgs descriptors. */
const OPTIONS = {
  transport: { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  path: { type: 'string' },
  mode: { type: 'string' },
  'cdp-endpoint': { type: 'string' },
  executable: { type: 'string' },
  profile: { type: 'string' },
  'user-data-dir': { type: 'string' },
  headless: { type: 'boolean' },
  headed: { type: 'boolean' },
  python: { type: 'string' },
  home: { type: 'string' },
  'no-eval': { type: 'boolean' },
  'no-screenshots': { type: 'boolean' },
  'no-jev': { type: 'boolean' },
  'jev-decider': { type: 'string' },
  'typesafe-base-url': { type: 'string' },
  'typesafe-model': { type: 'string' },
  'typesafe-api-key': { type: 'string' },
  'text-model-base-url': { type: 'string' },
  'text-model': { type: 'string' },
  'text-model-api-key': { type: 'string' },
  'text-model-reasoning': { type: 'string' },
  'request-timeout-ms': { type: 'string' },
  'log-level': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
}

/**
 * Parse one command line.
 *
 * @param {string[]} argv - arguments after the node executable and script.
 * @returns {{command: string, flags: object, help: boolean, version: boolean}}
 * @throws {Error} when the arguments are not a command line this server understands.
 */
export function parseCommandLine(argv = []) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new Error(`${error.message}\n\n${USAGE}`)
  }
  const { values, positionals } = parsed
  if (positionals.length > 1) throw new Error(`expected one command, got ${positionals.length}\n\n${USAGE}`)
  const command = positionals[0] ?? 'serve'
  if (!COMMANDS.includes(command)) throw new Error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
  const string = name => (values[name] === undefined ? undefined : String(values[name]))
  const flags = {
    transport: string('transport'),
    host: string('host'),
    port: string('port'),
    path: string('path'),
    mode: string('mode'),
    cdpEndpoint: string('cdp-endpoint'),
    executablePath: string('executable'),
    profile: string('profile'),
    userDataDir: string('user-data-dir'),
    headless: values.headless === true ? true : values.headed === true ? false : undefined,
    pythonPath: string('python'),
    browserUseMcpHome: string('home'),
    noEval: values['no-eval'] === true,
    noScreenshots: values['no-screenshots'] === true,
    noJev: values['no-jev'] === true,
    jevDecider: string('jev-decider'),
    typesafeBaseURL: string('typesafe-base-url'),
    typesafeModel: string('typesafe-model'),
    typesafeApiKey: string('typesafe-api-key'),
    textModelBaseURL: string('text-model-base-url'),
    textModel: string('text-model'),
    textModelApiKey: string('text-model-api-key'),
    textModelReasoning: string('text-model-reasoning'),
    requestTimeoutMs: string('request-timeout-ms'),
    logLevel: string('log-level'),
  }
  return { command, flags, help: values.help === true, version: values.version === true }
}
