/**
 * One resolved configuration: command-line flags over environment variables over defaults.
 *
 * Nothing else in the server reads `process.env` for configuration, and nothing reads a flag. This is
 * the one place that knows both, so the doctor and a browser call can never disagree about what the
 * server was told.
 *
 * @module browser-use-mcp/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** A command line or environment value this server cannot use, with the value that fixes it. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** The documented defaults, which are also what the doctor reports for an unset field. */
export const DEFAULTS = {
  transport: 'stdio',
  host: '127.0.0.1',
  port: 7331,
  path: '/mcp',
  // The point of this server is usually "use the browser I already use": driving the Chrome that is
  // running costs no new profile and no new logins. `--mode launch` switches to a dedicated browser.
  mode: 'attach',
  /**
   * When several MCP sessions drive the browser you already use, they each get their own tab and
   * their own CDP connection. `exclusive` refuses the second session instead (and is the safer
   * choice when two agents must never touch the same browser); `shared` is the default because the
   * common case is one server serving several agents against one Chrome.
   */
  attachSharing: 'shared',
  cdpEndpoint: '',
  executablePath: '',
  profile: 'default',
  userDataDir: '',
  headless: false,
  browserUseMcpHome: join(homedir(), '.browser-use-mcp'),
  pythonPath: '',
  allowEval: true,
  allowScreenshots: true,
  jev: {
    enabled: true,
    decider: 'typesafe',
    typesafe: { baseURL: '', model: '', fallbackURL: '', apiKey: '' },
    textModel: { baseURL: '', model: '', reasoning: 'thinking-disabled', headers: {}, apiKey: '' },
  },
  requestTimeoutMs: 180_000,
  // An HTTP MCP session silent for this long has its browser closed; a closed browser must not keep
  // a profile, a process, and a CDP connection for an agent that is never coming back.
  httpIdleMs: 15 * 60_000,
  logLevel: 'info',
}

const TRANSPORTS = ['stdio', 'http']
const MODES = ['launch', 'attach']
const DECIDERS = ['typesafe', 'chat']
const REASONING = ['', 'none', 'thinking-disabled']
const LOG_LEVELS = ['silent', 'error', 'info', 'debug']
/** A profile name becomes a directory name, so only this shape can be one. */
const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/u
const HTTP_URL = /^(?:https?|wss?):\/\/\S+$/u

/** `~` and `~/…` expand to the home directory; everything else is returned trimmed. */
export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(1))
  return value
}

/** One environment variable as a trimmed string, or undefined when it is unset or blank. */
function envValue(env, name) {
  const value = env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** An environment switch: `1/true/yes/on` is true, `0/false/no/off` is false, anything else is refused. */
export function envBoolean(env, name) {
  const raw = envValue(env, name)?.toLowerCase()
  if (raw === undefined) return undefined
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  throw new ConfigError(`${name} must be a boolean (1/true/yes/on or 0/false/no/off), not ${JSON.stringify(env[name])}`)
}

/** The first value that is not undefined, so a flag of `undefined` never shadows the environment. */
function pick(...values) {
  return values.find(value => value !== undefined)
}

/** A whole number in `[min, max]`, or the fallback when the value is unset. */
function integer(value, label, fallback, min, max) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ConfigError(`${label} must be an integer between ${min} and ${max}, not ${JSON.stringify(value)}`)
  }
  return number
}

/** One enum value, case-insensitive, with the accepted set in the error. */
function oneOf(value, label, accepted) {
  if (value === undefined) return undefined
  const normalized = String(value).trim().toLowerCase()
  if (!accepted.includes(normalized)) {
    throw new ConfigError(`${label} must be one of ${accepted.map(item => JSON.stringify(item)).join(', ')}, not ${JSON.stringify(value)}`)
  }
  return normalized
}

/** An http(s)/ws(s) URL, or the empty string. */
function endpoint(value, label) {
  if (value === undefined || value === '') return ''
  const trimmed = String(value).trim()
  if (!HTTP_URL.test(trimmed)) throw new ConfigError(`${label} must be an http(s) or ws(s) URL without whitespace, not ${JSON.stringify(value)}`)
  return trimmed
}

/** A path setting: home expanded, relative paths resolved against the working directory. */
function pathSetting(value, cwd) {
  if (value === undefined || value === '') return ''
  return resolve(cwd, expandHome(String(value).trim()))
}

/** JSON object of string values, as `TEXT_MODEL_HEADERS` carries request headers. */
function headerObject(value) {
  if (value === undefined || value === '') return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new ConfigError(`TEXT_MODEL_HEADERS must be a JSON object: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.values(parsed).some(item => typeof item !== 'string')) {
    throw new ConfigError('TEXT_MODEL_HEADERS must be a JSON object whose values are strings')
  }
  return { ...parsed }
}

/**
 * Resolve one command line and environment into the configuration every other module reads.
 *
 * @param {object} input
 * @param {string} [input.command] - `serve`, `doctor` or `install`.
 * @param {object} [input.flags] - the parsed command-line flags from `./cli.js`.
 * @param {NodeJS.ProcessEnv} [input.env] - the environment to read (default `process.env`).
 * @param {string} [input.cwd] - working directory for relative paths.
 * @returns {object} the resolved configuration.
 * @throws {ConfigError} with the field that has to change.
 */
export function resolveConfig({ command = 'serve', flags = {}, env = process.env, cwd = process.cwd() } = {}) {
  const transport = oneOf(pick(flags.transport, envValue(env, 'BROWSER_USE_MCP_TRANSPORT'), DEFAULTS.transport), 'transport', TRANSPORTS)
  const host = String(pick(flags.host, envValue(env, 'BROWSER_USE_MCP_HOST'), DEFAULTS.host)).trim()
  if (host === '') throw new ConfigError('host must not be empty')
  const port = integer(pick(flags.port, envValue(env, 'BROWSER_USE_MCP_PORT')), 'port', DEFAULTS.port, 1, 65_535)
  let route = String(pick(flags.path, envValue(env, 'BROWSER_USE_MCP_PATH'), DEFAULTS.path)).trim()
  if (!route.startsWith('/')) route = `/${route}`
  if (/\s/u.test(route)) throw new ConfigError(`path must not contain whitespace, not ${JSON.stringify(route)}`)

  const cdpEndpoint = endpoint(pick(flags.cdpEndpoint, envValue(env, 'BROWSER_USE_MCP_CDP_ENDPOINT'), ''), 'cdpEndpoint')
  const explicitMode = oneOf(pick(flags.mode, envValue(env, 'BROWSER_USE_MCP_MODE')), 'mode', MODES)
  // A configured endpoint names a running browser, which is what attach means; saying both
  // "launch" and an endpoint would silently ignore the mode, so only the consistent pair is accepted.
  if (explicitMode === 'launch' && cdpEndpoint !== '') {
    throw new ConfigError('cdpEndpoint belongs to attach mode; drop one of --mode launch / --cdp-endpoint')
  }
  const mode = explicitMode ?? (cdpEndpoint !== '' ? 'attach' : DEFAULTS.mode)

  const explicitSharing = oneOf(
    pick(flags.attachSharing, envValue(env, 'BROWSER_USE_MCP_ATTACH_SHARING')),
    'attach-sharing',
    ['exclusive', 'shared'],
  )
  if (mode === 'launch' && explicitSharing === 'shared') {
    throw new ConfigError('attachSharing "shared" needs attach mode; a launched browser already belongs to one session')
  }
  // Launch mode has nothing to share, so the resolved value is always exclusive there. This keeps
  // the doctor from advertising a setting that does nothing.
  const attachSharing = mode === 'attach' ? (explicitSharing ?? DEFAULTS.attachSharing) : 'exclusive'

  const executablePath = pathSetting(pick(flags.executablePath, envValue(env, 'BROWSER_USE_MCP_EXECUTABLE_PATH')), cwd)
  const profile = String(pick(flags.profile, envValue(env, 'BROWSER_USE_MCP_PROFILE'), DEFAULTS.profile)).trim()
  if (!PROFILE_NAME.test(profile) || profile === '.' || profile === '..') {
    throw new ConfigError(`profile must match [A-Za-z0-9._-]{1,64} and not be a relative path, not ${JSON.stringify(profile)}`)
  }
  const browserUseMcpHome = pathSetting(
    pick(flags.browserUseMcpHome, envValue(env, 'BROWSER_USE_MCP_HOME'), DEFAULTS.browserUseMcpHome),
    cwd,
  )
  const userDataDir = pathSetting(pick(flags.userDataDir, envValue(env, 'BROWSER_USE_MCP_USER_DATA_DIR')), cwd)
    || join(browserUseMcpHome, 'profiles', profile)
  const headless = pick(flags.headless, envBoolean(env, 'BROWSER_USE_MCP_HEADLESS'), DEFAULTS.headless)
  if (typeof headless !== 'boolean') throw new ConfigError('headless must be true or false')

  const pythonPath = pathSetting(pick(flags.pythonPath, envValue(env, 'BROWSER_USE_MCP_PYTHON')), cwd)

  // `--no-eval` (or BROWSER_USE_MCP_NO_EVAL=1) withdraws the tool; BROWSER_USE_MCP_EVAL=0 is the
  // same answer said positively, so either spelling means the same thing.
  const allowEval = flags.noEval !== true
    && envBoolean(env, 'BROWSER_USE_MCP_NO_EVAL') !== true
    && envBoolean(env, 'BROWSER_USE_MCP_EVAL') !== false
  const allowScreenshots = flags.noScreenshots !== true
    && envBoolean(env, 'BROWSER_USE_MCP_NO_SCREENSHOTS') !== true
    && envBoolean(env, 'BROWSER_USE_MCP_SCREENSHOTS') !== false

  const jevOff = flags.noJev === true
    || envBoolean(env, 'BROWSER_USE_MCP_NO_JEV') === true
    || ['off', 'false', '0', 'no'].includes(String(envValue(env, 'BROWSER_USE_MCP_JEV') ?? '').toLowerCase())
  const decider = oneOf(pick(flags.jevDecider, envValue(env, 'JEV_DECIDER'), DEFAULTS.jev.decider), 'jev-decider', DECIDERS)
  const reasoning = oneOf(
    pick(flags.textModelReasoning, envValue(env, 'TEXT_MODEL_REASONING'), DEFAULTS.jev.textModel.reasoning),
    'text-model-reasoning',
    REASONING,
  )
  const jev = {
    enabled: !jevOff,
    decider,
    typesafe: {
      baseURL: endpoint(pick(flags.typesafeBaseURL, envValue(env, 'TYPESAFE_BASE_URL'), ''), 'typesafe-base-url'),
      model: String(pick(flags.typesafeModel, envValue(env, 'TYPESAFE_MODEL'), '')).trim(),
      fallbackURL: endpoint(envValue(env, 'TYPESAFE_FALLBACK_URL') ?? '', 'TYPESAFE_FALLBACK_URL'),
      apiKey: String(pick(flags.typesafeApiKey, envValue(env, 'TYPESAFE_API_KEY'), '')).trim(),
    },
    textModel: {
      baseURL: endpoint(pick(flags.textModelBaseURL, envValue(env, 'TEXT_MODEL_BASE_URL'), ''), 'text-model-base-url'),
      model: String(pick(flags.textModel, envValue(env, 'TEXT_MODEL'), '')).trim(),
      reasoning,
      headers: headerObject(envValue(env, 'TEXT_MODEL_HEADERS')),
      apiKey: String(pick(flags.textModelApiKey, envValue(env, 'TEXT_MODEL_API_KEY'), '')).trim(),
    },
  }

  const requestTimeoutMs = integer(
    pick(flags.requestTimeoutMs, envValue(env, 'BROWSER_USE_MCP_REQUEST_TIMEOUT_MS')),
    'request-timeout-ms',
    DEFAULTS.requestTimeoutMs,
    1_000,
    3_600_000,
  )
  const httpIdleMs = integer(
    envValue(env, 'BROWSER_USE_MCP_HTTP_IDLE_MS'),
    'BROWSER_USE_MCP_HTTP_IDLE_MS',
    DEFAULTS.httpIdleMs,
    1_000,
    24 * 60_000,
  )
  const logLevel = oneOf(pick(flags.logLevel, envValue(env, 'BROWSER_USE_MCP_LOG_LEVEL'), DEFAULTS.logLevel), 'log-level', LOG_LEVELS)

  return {
    command,
    transport,
    host,
    port,
    path: route,
    mode,
    attachSharing,
    cdpEndpoint,
    executablePath,
    profile,
    userDataDir,
    headless,
    browserUseMcpHome,
    pythonPath,
    allowEval,
    allowScreenshots,
    jev,
    requestTimeoutMs,
    httpIdleMs,
    logLevel,
  }
}

/**
 * The connection parameters one request that may start a browser carries.
 *
 * A call that does not start a browser still sends them: the sidecar reads them only when it has to
 * connect, so the same object is correct for every request.
 * @param {object} config - the resolved configuration.
 * @param {object} [overrides] - a profile directory or headless switch for one session (HTTP mode).
 */
export function connectionFor(config, overrides = {}) {
  const userDataDir = overrides.userDataDir ?? config.userDataDir
  const headless = overrides.headless ?? config.headless
  return {
    mode: config.mode,
    ...(config.cdpEndpoint === '' ? {} : { cdpEndpoint: config.cdpEndpoint }),
    ...(config.executablePath === '' ? {} : { executablePath: config.executablePath }),
    userDataDir,
    ...(headless ? { headless: true } : {}),
  }
}

/** Whether a value is set, without ever printing the value: the doctor's only safe key answer. */
export function presence(value) {
  return value === undefined || value === null || String(value).trim() === '' ? 'unset' : 'set'
}

/**
 * The configuration as the doctor reads it: what is in use, never a secret.
 * @param {object} config - the resolved configuration.
 * @returns {string[]} one line per setting group.
 */
export function describeConfig(config) {
  const lines = []
  lines.push(
    config.transport === 'stdio'
      ? 'Transport: stdio (MCP over stdin/stdout)'
      : `Transport: Streamable HTTP http://${config.host}:${config.port}${config.path}`,
  )
  lines.push(
    config.mode === 'attach'
      ? `Connection: attach to ${config.cdpEndpoint || 'the Chrome you browse with (found through chrome://inspect remote debugging)'}`
        + `, attach sharing ${config.attachSharing}`
      : `Connection: launch ${config.executablePath || 'Chrome/Chromium'}, profile "${config.profile}" at ${config.userDataDir}${config.headless ? ', headless' : ''}`
        + (config.transport === 'http' ? ' (named profiles persist; unnamed sessions get an ephemeral profile)' : ''),
  )
  if (config.jev.enabled) {
    const who = config.jev.decider === 'chat'
      ? `decided by the text model at ${config.jev.textModel.baseURL || '(engine default endpoint)'} (model ${config.jev.textModel.model || '(engine default)'}, key ${presence(config.jev.textModel.apiKey)})`
      : `decided by Jev at ${config.jev.typesafe.baseURL || '(default endpoint)'} (model ${config.jev.typesafe.model || '(default)'}, key ${presence(config.jev.typesafe.apiKey)})`
    lines.push(`Jev     : enabled, ${who}; browser_goal and browser_act intents spend model quota`)
  } else {
    lines.push('Jev     : off (browser_goal and browser_act intents are not offered)')
  }
  lines.push(`State   : ${config.browserUseMcpHome}${config.pythonPath ? ` (interpreter ${config.pythonPath})` : ' (managed Python environment)'}`)
  lines.push(`Timeouts: ${Math.round(config.requestTimeoutMs / 1000)}s per browser request`)
  if (config.transport === 'http') {
    const idle = config.httpIdleMs < 60_000
      ? `${(config.httpIdleMs / 1000).toFixed(config.httpIdleMs % 1000 === 0 ? 0 : 1)} seconds`
      : `${Math.round(config.httpIdleMs / 60_000)} minutes`
    lines.push(`HTTP     : idle MCP sessions are closed after ${idle}`)
  }
  lines.push(`Logging : ${config.logLevel} (stderr)`)
  return lines
}
