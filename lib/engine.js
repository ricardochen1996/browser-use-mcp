/**
 * Finding, checking, and (when this server owns the environment) installing the engine.
 *
 * The sidecar is Python and the engine it drives is a Python package, so before the first browser
 * call this server has to answer: which interpreter imports `jev_ultrafast`, which browser can be
 * driven, and what should a person do when either is missing. `inspectEngine` only looks — it never
 * installs — and is what the doctor tool, the server's startup log, and a browser tool's refusal
 * share. `ensureEngine` is the one that acts: when no interpreter imports the engine and the
 * managed environment is the one in use, it installs the engine there first.
 *
 * Two rules shape the interpreter list. A configured `--python` is the answer or the failure: the
 * probe tries it alone, because falling back to another interpreter would silently ignore the
 * configuration. Otherwise the managed environment (which this server builds, see `./provision.js`)
 * is tried first, then the Pythons a machine already has. The list is probed in order, and a cached
 * success is what keeps a doctor call from spawning a Python per HTTP request.
 *
 * @module browser-use-mcp/engine
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { connect } from 'node:net'
import { delimiter, isAbsolute, join } from 'node:path'

import { basePythons, environmentPython } from './python.js'
import {
  PACKAGE_ROOT,
  bundledEngine,
  duration,
  environmentRecord,
  installEngine,
  installHint,
  installStatus,
  ownEnvironment,
} from './provision.js'

/** This package's own root: the sidecar ships here and the managed environment lives here. */
export { PACKAGE_ROOT }

/** The sidecar that is started, and the one file that has to exist for it to exist. */
export const SIDECAR = join(PACKAGE_ROOT, 'sidecar', 'bridge.py')

/** The bundled engine wheel and its hash-pinned requirements. */
export const VENDOR = join(PACKAGE_ROOT, 'vendor')

/** How the environment this server builds for itself is named in reports. */
const OWN = 'managed environment'

/** How long one engine probe may take: importing the engine imports Browser Harness too. */
const PROBE_TIMEOUT_MS = 60000

/** How long one attach check may take before the target counts as not answering. */
const ATTACH_TIMEOUT_MS = 3000

/**
 * What the probe asks the interpreter to report; importing the engine imports Browser Harness too.
 *
 * `importlib.metadata` is asked for the distribution versions instead of a `__version__` attribute
 * because the wheel name is what was installed, and a missing version is reported as `unknown`
 * rather than making a working engine look broken.
 */
const PROBE = [
  '-c',
  [
    'import importlib, importlib.metadata as metadata, json, sys',
    'def installed(name):',
    '    try:',
    '        return metadata.version(name)',
    '    except Exception:',
    '        return "unknown"',
    'engine = importlib.import_module("jev_ultrafast")',
    'harness = importlib.import_module("browser_harness")',
    'json.dump({',
    '    "python": ".".join(str(part) for part in sys.version_info[:3]),',
    '    "engine": installed("jev-ultrafast"),',
    '    "enginePath": list(engine.__path__)[0],',
    '    "browserHarness": installed("browser-harness"),',
    '}, sys.stdout)',
  ].join('\n'),
]

/**
 * Interpreter list -> the probe answer that found the engine there.
 *
 * Only a success is remembered: an engine installed a moment later (by this server, or by a person
 * following the doctor's fix) has to be found by the next call, while a machine that answered once
 * does not answer again on every browser call.
 */
const found = new Map()

/** The candidates' identity for the probe cache; two lists with the same commands are one list. */
function cacheKey(candidates) {
  return candidates.map(item => [item.command, ...item.prefix].join(' ')).join('\u0000')
}

/**
 * Whether this server may install the engine itself: only when no explicit interpreter was named.
 * There is no external project concept here — the engine always comes from the bundled wheel — so
 * an explicit `--python` is the one thing that makes the environment someone else's to manage.
 * @param {object} [config] - resolved server configuration.
 * @returns {boolean}
 */
export function installable(config = {}) {
  return String(config.pythonPath ?? '').trim() === ''
}

/**
 * Every interpreter worth trying, best first, each with the reason it is on the list.
 *
 * A configured `pythonPath` is the answer or the failure, so it is the only candidate. Otherwise the
 * environment this server builds comes first: when it exists it is the environment the sidecar
 * should run in, and when it does not the probe's failure is what tells `ensureEngine` to build it.
 * The Pythons from `lib/python.js` follow, for a machine where the managed environment is not there
 * yet or was built for another purpose. uv is skipped here on purpose: it builds environments, it is
 * not an interpreter, and probing `uv -c` would only add a failure that says nothing.
 * @param {object} [config] - resolved server configuration.
 * @returns {{command: string, prefix: string[], cwd: string, source: string}[]}
 */
export function interpreterCandidates(config = {}) {
  const pythonPath = String(config.pythonPath ?? '').trim()
  if (pythonPath !== '') {
    return [{ command: pythonPath, prefix: [], cwd: PACKAGE_ROOT, source: 'pythonPath' }]
  }
  const candidates = [{
    command: environmentPython(ownEnvironment(config)),
    prefix: [],
    cwd: PACKAGE_ROOT,
    source: OWN,
  }]
  const add = (command, prefix, source) => {
    if (candidates.some(item => item.command === command && item.prefix.join(' ') === prefix.join(' '))) return
    candidates.push({ command, prefix, cwd: PACKAGE_ROOT, source })
  }
  for (const candidate of basePythons(config)) {
    if (candidate.source === 'uv') continue
    add(candidate.command, candidate.prefix, candidate.source)
  }
  return candidates
}

/**
 * The interpreter that runs the sidecar when nothing has probed one yet.
 *
 * Only for callers that must name an interpreter before a report exists; the normal path uses
 * `report.interpreter`, which is the one the probe actually accepted.
 * @param {object} [config] - resolved server configuration.
 * @returns {{command: string, prefix: string[], cwd: string, source: string}}
 */
export function resolveInterpreter(config = {}) {
  return interpreterCandidates(config)[0]
}

/**
 * Run one probe program on an interpreter.
 *
 * A missing absolute interpreter is reported without spawning it: the managed environment not
 * existing yet is the ordinary first-run case, not an error worth a process. Everything else is
 * spawned and every way it can go wrong — cannot start, timeout, nonzero exit, unreadable answer —
 * becomes `{failure}` so the doctor can name each interpreter it tried.
 * @param {{command: string, prefix: string[], cwd: string, source: string}} interpreter
 * @param {string[]} [program] - argv after the interpreter; the engine import probe by default.
 * @returns {Promise<{report: object}|{failure: string}>}
 */
export function probe(interpreter, program = PROBE) {
  if (interpreter === undefined || typeof interpreter.command !== 'string') {
    return Promise.resolve({ failure: 'no interpreter was named' })
  }
  if (isAbsolute(interpreter.command) && !existsSync(interpreter.command)) {
    return Promise.resolve({
      failure: interpreter.source === OWN ? 'not installed yet' : 'does not exist',
    })
  }
  return new Promise(resolve => {
    let child
    try {
      child = spawn(interpreter.command, [...interpreter.prefix, ...program], {
        cwd: interpreter.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ failure: `${interpreter.command} could not be started: ${error.message}` })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ failure: `the probe did not answer within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s` })
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.on('error', error => {
      settle({ failure: `${interpreter.command} could not be started: ${error.message}` })
    })
    child.on('close', code => {
      if (code !== 0) {
        const detail = err.trim().split('\n').filter(Boolean).at(-1) ?? `exit status ${code}`
        settle({ failure: detail })
        return
      }
      let report
      try {
        report = JSON.parse(out)
      } catch {
        settle({ failure: `the probe answered something unreadable: ${out.slice(0, 120)}` })
        return
      }
      if (report === null || typeof report !== 'object') {
        settle({ failure: `the probe answered something unexpected: ${out.slice(0, 120)}` })
        return
      }
      // The engine probe has a fixed shape; the attach probe answers a profile or a reason, so the
      // shape check belongs to the program that was run, not to every program.
      if (program === PROBE
          && (typeof report.python !== 'string' || typeof report.enginePath !== 'string')) {
        settle({ failure: `the probe answered something unexpected: ${out.slice(0, 120)}` })
        return
      }
      settle({ report })
    })
  })
}

/** Probe the candidates in order: the first interpreter that imports the engine wins. */
async function findEngine(candidates) {
  const search = { interpreter: candidates[0], attempts: [] }
  for (const candidate of candidates) {
    const result = await probe(candidate)
    if (result.report !== undefined) {
      search.interpreter = candidate
      search.engine = result.report
      break
    }
    search.attempts.push({ ...candidate, failure: result.failure })
  }
  return search
}

/**
 * The problem a missing engine is, and its fix, which depends on who owns the environment.
 *
 * Every branch answers with a code, a message that names what was tried, and a fix someone can act
 * on: the install command for the managed environment, the pip command for a configured
 * interpreter, or the state of an install that is already running.
 */
function missingEngine(config, report) {
  const tried = report.attempts.length === 0
    ? 'no interpreter answered'
    : report.attempts.map(item => `${item.command} (${item.source}): ${item.failure}`).join('\n    ')
  if (String(config.pythonPath ?? '').trim() !== '') {
    const wheel = bundledEngine()
    const install = wheel === undefined
      ? 'install the engine into that interpreter'
      : `install the engine into that interpreter (uv pip install --python ${config.pythonPath} ${wheel.path})`
    return [
      'no_engine',
      `the configured --python cannot import the engine:\n    ${tried}`,
      `${install}, or clear --python and this server installs an environment of its own`,
    ]
  }
  const install = report.install
  if (install === undefined) {
    return [
      'no_engine',
      `the browser engine is not installed yet in ${ownEnvironment(config)}`,
      `the next browser call installs it; to install it now: ${installHint(config)}`,
    ]
  }
  if (install.state === 'installing') {
    return [
      'installing',
      `the browser engine is being installed into ${install.environment} `
      + `(for ${duration(Date.now() - install.startedAt)}; ${install.step})`,
      'wait: browser calls wait for this install, and browser_doctor shows how far it got',
    ]
  }
  if (install.state === 'failed') {
    return install.code === 'no_python' || install.code === 'no_uv'
      ? [install.code, install.error, install.fix]
      : ['install_failed', `installing the browser engine failed: ${install.error}`, install.fix]
  }
  return [
    'install_failed',
    `the browser engine was installed into ${install.environment}, and it still does not import: `
    + `${report.attempts.at(-1)?.failure ?? 'no answer'}`,
    `delete ${install.environment}, then retry: ${installHint(config)}`,
  ]
}

/** The browser `attach` mode drives: the configured endpoint, or the one you browse with. */
function attachTarget(config) {
  return config.cdpEndpoint
    ? config.cdpEndpoint
    : 'your running Chrome (found through chrome://inspect remote debugging)'
}

/** What to do about an attach target that does not answer, whatever the reason. */
const ATTACH_ESCAPE = 'start that browser with remote debugging on (chrome://inspect/#remote-debugging), '
  + 'correct --cdp-endpoint, or set --mode launch and this server starts its own browser'

/**
 * The address `/json/version` answers at, for an endpoint that may already name it.
 *
 * Chrome resolves an HTTP DevTools address through this route, which keeps an HTTP endpoint working
 * after the browser restarts, while a ws URL carries an id Chrome mints afresh on every start.
 */
function versionURL(endpoint) {
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/u, '')
  if (!path.endsWith('/json/version')) url.pathname = `${path}/json/version`
  url.search = ''
  url.hash = ''
  return url
}

/** Ask one URL for its version document, over a socket this request owns and closes. */
function fetchVersion(url) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsGet : httpGet)(url, { agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error('the answer was not the JSON /json/version returns'))
        }
      })
    })
    request.setTimeout(ATTACH_TIMEOUT_MS,
      () => request.destroy(new Error(`no answer within ${ATTACH_TIMEOUT_MS / 1000}s`)))
    request.on('error', reject)
  })
}

/** Whether anything is listening at one host and port, which is all a ws endpoint can be asked. */
function listening(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = reachable => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(ATTACH_TIMEOUT_MS, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/**
 * Whether the configured DevTools endpoint answers, and what it says it is.
 *
 * An HTTP endpoint is asked the way the engine asks it — `GET /json/version` — so this check and the
 * first browser call get the same answer. A ws endpoint is only asked whether anything is listening:
 * it names one browser id, and a WebSocket handshake here would open a second CDP connection to
 * answer a question this check does not need.
 */
async function checkEndpoint(endpoint) {
  const url = new URL(endpoint)
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80))
    if (await listening(url.hostname, port)) {
      return { checked: true, reachable: true, detail: `${endpoint} answers on ${url.host}` }
    }
    return {
      checked: true,
      reachable: false,
      detail: `${endpoint} \u2014 nothing is listening at ${url.host}`,
      code: 'attach_unreachable',
      message: `attach mode drives ${endpoint}, and nothing is listening at ${url.host}`,
      fix: ATTACH_ESCAPE,
    }
  }
  const asked = versionURL(endpoint)
  try {
    const answer = await fetchVersion(asked)
    const browser = typeof answer?.Browser === 'string' && answer.Browser !== '' ? ` \u2014 ${answer.Browser}` : ''
    return { checked: true, reachable: true, detail: `${endpoint} answers${browser}` }
  } catch (error) {
    return {
      checked: true,
      reachable: false,
      detail: `${endpoint} \u2014 ${asked.href} did not answer`,
      code: 'attach_unreachable',
      message: `attach mode drives ${endpoint}, and ${asked.href} did not answer (${error.message})`,
      fix: ATTACH_ESCAPE,
    }
  }
}

/**
 * What the engine's own discovery answers, run on the interpreter the sidecar would use.
 *
 * `attach` without an endpoint drives the browser you browse with, which the engine finds through
 * the `DevToolsActivePort` Chrome publishes into the profile it was started with. Asking the engine
 * itself keeps this check and the first browser call from disagreeing about what is there; the probe
 * only reads what is already published, it opens no page and does not wait for a prompt.
 */
const ATTACH_PROBE = [
  '-c',
  [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("browser_use_mcp_bridge", sys.argv[1])',
    'bridge = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(bridge)',
    'try:',
    '    json.dump({"profile": str(bridge.discover_local_browser())}, sys.stdout)',
    'except bridge.BridgeError as error:',
    '    json.dump({"kind": error.kind, "message": str(error)}, sys.stdout)',
  ].join('\n'),
  SIDECAR,
]

/** The attach probe's answer: the profile the engine found, or why it found none. */
async function probeAttachBrowser(interpreter) {
  const result = await probe(interpreter, ATTACH_PROBE)
  if (result.report !== undefined) return result.report
  return { kind: 'probe_failed', message: result.failure }
}

/**
 * Whether `attach` mode can reach the browser it is configured to drive.
 *
 * This asks the question the first browser call asks, before that call: a configured endpoint
 * directly, and the browser you browse with through the engine that would find it. What it finds is
 * what makes `ok` mean "the browser tools would work" in this mode too, instead of the server
 * reporting a ready engine while the browser it was told to drive is not there. It never throws:
 * a malformed endpoint or a probe that cannot run is an answer, not a crash.
 * @param {object} [config] - resolved server configuration.
 * @param {{command: string, prefix: string[], cwd: string, source: string}} [interpreter] - the
 *   interpreter that imports the engine, or `undefined` when none does.
 * @returns {Promise<{target: string, checked: boolean, reachable?: boolean, detail: string,
 *   code?: string, message?: string, fix?: string}>}
 */
export async function inspectAttach(config = {}, interpreter) {
  const target = attachTarget(config)
  try {
    if (config.cdpEndpoint) return { target, ...await checkEndpoint(config.cdpEndpoint) }
    if (interpreter === undefined) {
      return { target, checked: false, detail: `${target} \u2014 not checked: the engine is not installed yet` }
    }
    const answer = await probeAttachBrowser(interpreter)
    if (answer.profile !== undefined) {
      return { target, checked: true, reachable: true, detail: `${target} \u2014 profile ${answer.profile}` }
    }
    if (answer.kind === 'no_permission' || answer.kind === 'no_browser') {
      return {
        target,
        checked: true,
        reachable: false,
        detail: `${target} \u2014 not found`,
        // The engine's own codes and words, so the doctor and the first browser call agree.
        code: answer.kind,
        message: answer.message ?? `the engine found no running browser to attach to`,
        fix: ATTACH_ESCAPE,
      }
    }
    return {
      target,
      checked: false,
      reachable: false,
      detail: `${target} \u2014 not checked: ${answer.message ?? 'the check could not run'}`,
      code: 'attach_unchecked',
      message: `attach mode drives ${target}, and the check could not run: `
        + `${answer.message ?? 'the engine answered nothing'}`,
      fix: 'check the interpreter this report names, then call browser_doctor again',
    }
  } catch (error) {
    const reason = error?.message ?? String(error)
    return {
      target,
      checked: false,
      reachable: false,
      detail: `${target} \u2014 not checked: ${reason}`,
      code: 'attach_unchecked',
      message: `attach mode could not check ${target}: ${reason}`,
      fix: ATTACH_ESCAPE,
    }
  }
}

/** Whether a configured value counts as set, without ever exposing it. */
function isConfigured(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * One line on how a browser goal would decide, without printing a credential.
 *
 * The doctor has to say whether the tools that spend model quota will work, and the answer is
 * whether the key they need exists — never its value. The process environment is checked as well as
 * the resolved config, because Jev's own variables are the documented way an MCP client supplies a
 * key and a config that predates this code may not carry them.
 */
function goalModeText(config) {
  const jev = config.jev ?? {}
  const typesafe = jev.typesafe ?? {}
  const textModel = jev.textModel ?? {}
  if (jev.decider === 'chat') {
    const configured = isConfigured(textModel.apiKey) || isConfigured(textModel.baseURL)
      || isConfigured(textModel.model) || isConfigured(process.env.TEXT_MODEL_API_KEY)
      || isConfigured(process.env.TEXT_MODEL)
    return 'enabled: browser_goal and browser_act intents spend model quota; the text model decides '
      + `(jev.decider: chat), the chat text model is ${configured ? 'set' : 'unset'}`
  }
  const configured = isConfigured(typesafe.apiKey) || isConfigured(process.env.TYPESAFE_API_KEY)
  return 'enabled: browser_goal and browser_act intents spend model quota; Jev decides, '
    + `TYPESAFE_API_KEY is ${configured ? 'set' : 'unset'}`
}

/**
 * Everything a person needs to know before the first browser tool call.
 *
 * This only looks: `ensureEngine` is what installs a missing engine. It never throws for an
 * environment problem — every failure becomes a problem with a code, a message naming what was
 * tried, and a fix someone can read.
 * @param {object} [config] - resolved server configuration.
 * @param {{fresh?: boolean}} [options] - `fresh` probes again instead of using the remembered
 *   answer, for a doctor call the user just asked for.
 * @returns {Promise<object>} the engine report: `{ok, sidecar, interpreter, attempts, problems,
 *   engine?, install?, browser?, attach?, goalMode?}`.
 */
export async function inspectEngine(config = {}, options = {}) {
  const candidates = interpreterCandidates(config)
  const key = cacheKey(candidates)
  let search = options.fresh === true ? undefined : found.get(key)
  if (search === undefined) {
    search = await findEngine(candidates)
    if (search.engine === undefined) found.delete(key)
    else found.set(key, search)
  }

  const report = {
    ok: true,
    sidecar: SIDECAR,
    interpreter: search.interpreter,
    attempts: [...search.attempts],
    problems: [],
  }
  if (search.engine !== undefined) report.engine = search.engine
  if (installable(config)) report.install = installStatus()
  const problem = (code, message, fix) => {
    report.problems.push({ code, message, fix })
    report.ok = false
  }

  if (!existsSync(SIDECAR)) {
    problem('no_sidecar', `the sidecar is missing: ${SIDECAR}`,
      'reinstall the package: sidecar/bridge.py ships beside lib/')
  }
  if (report.engine === undefined) problem(...missingEngine(config, report))

  if (config.mode === 'attach') {
    // What this mode drives, and whether it is there now: the first browser call asks the same
    // question, and the answer is what keeps "ready" from meaning only "the engine imports".
    report.attach = await inspectAttach(config,
      search.engine === undefined ? undefined : search.interpreter)
    if (report.attach.code !== undefined) problem(report.attach.code, report.attach.message, report.attach.fix)
  } else {
    report.browser = findBrowser(config)
    if (report.browser === undefined) {
      problem('no_browser', 'no Chrome or Chromium executable was found',
        'install Chrome, or set --executable to the browser to launch')
    }
  }
  if (config.jev?.enabled) report.goalMode = goalModeText(config)
  return report
}

/**
 * The engine report, after installing the engine if this server owns the environment and finds none.
 *
 * The first caller starts the install and every caller meanwhile waits for that same one, so the
 * startup check, a browser call, and a doctor call never run two installs. A recorded environment
 * that stopped importing is rebuilt: installing again without `force` would only reuse the record.
 * @param {object} [config] - resolved server configuration.
 * @param {{fresh?: boolean, install?: boolean, onInstall?: (status: object) => void,
 *   onOutput?: (line: string) => void}} [options] - `install` retries a failed install at once
 *   instead of answering from it; `fresh` probes again first; `onInstall(status)` hears that an
 *   install is running; `onOutput(line)` receives the installer's output while it does.
 * @returns {Promise<object>} the report after the install settled, or at once when nothing had to
 *   be installed.
 */
export async function ensureEngine(config = {}, options = {}) {
  const report = await inspectEngine(config, { fresh: options.fresh === true })
  if (report.engine !== undefined || !installable(config)) return report
  const force = options.install === true
    || environmentRecord(ownEnvironment(config)) !== undefined
  const install = installEngine(config, { force, onOutput: options.onOutput })
  const status = installStatus()
  if (status?.state === 'installing') options.onInstall?.(status)
  await install
  return inspectEngine(config, { fresh: true })
}

/**
 * Drop the remembered probe answers, so the next check runs the probe again.
 *
 * A person who follows the doctor's fix expects the next check to see it; without this, the
 * success-cache would be irrelevant but the install-a-moment-later case would not.
 */
export function forgetEngine() {
  found.clear()
}

/**
 * The browser a launched session would use: configured, then a PATH entry, then the macOS app.
 *
 * The order mirrors what `sidecar/bridge.py` does when it starts a browser, so a doctor that finds
 * one here is not contradicted by the first browser call. A configured `executablePath` that does
 * not exist falls through to discovery for the same reason.
 * @param {object} [config] - resolved server configuration.
 * @returns {string|undefined}
 */
export function findBrowser(config = {}) {
  const configured = String(config.executablePath ?? '').trim()
  if (configured !== '' && existsSync(configured)) return configured
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return process.platform === 'darwin' && existsSync(mac) ? mac : undefined
}

/** One line on the install this server ran, or is running, for its own environment. */
function installLine(report) {
  const install = report.install
  if (install === undefined) {
    return report.engine === undefined
      ? 'not run in this process'
      : 'none in this process; the engine is already importable'
  }
  const how = install.strategy === 'uv'
    ? 'uv'
    : install.strategy === 'python'
      ? `pip (Python ${install.pythonVersion ?? 'unknown'})`
      : 'an installer'
  if (install.state === 'installing') {
    return `running for ${duration(Date.now() - install.startedAt)} into ${install.environment} with ${how} `
      + `(${install.step})`
  }
  const took = duration((install.finishedAt ?? Date.now()) - install.startedAt)
  if (install.state === 'installed') return `installed into ${install.environment} with ${how} in ${took}`
  if (install.code === 'no_python' || install.code === 'no_uv') return `not possible: ${install.error}`
  return `failed after ${took}: ${install.error}`
}

/**
 * The report as text: what is ready, what is not, and the command that fixes each problem.
 *
 * The layout is the doctor's: fixed labels so a person can scan it, the interpreter and both engine
 * versions named on their own lines, and every problem followed by its fix. `extra` is appended
 * after the browser line, for a caller that has one more fact to show (a live session, say).
 * @param {object} report - a report from `inspectEngine` or `ensureEngine`.
 * @param {Record<string, string>} [extra] - additional `label -> line` pairs.
 * @returns {string}
 */
export function reportText(report, extra = {}) {
  const lines = []
  if (report.engine === undefined) {
    lines.push(`Engine   : not usable \u2014 tried ${report.attempts.length} interpreter(s)`)
    for (const item of report.attempts) {
      lines.push(`           ${item.command} (${item.source}): ${item.failure}`)
    }
  } else {
    lines.push(`Engine   : ${report.interpreter.command} (Python ${report.engine.python}, `
      + `chosen by ${report.interpreter.source})`)
    lines.push(`           jev_ultrafast ${report.engine.engine} at ${report.engine.enginePath}`)
    lines.push(`           browser-harness ${report.engine.browserHarness}`)
  }
  lines.push(`Install  : ${installLine(report)}`)
  lines.push(`Sidecar  : ${report.sidecar}`)
  if (report.attach !== undefined) {
    lines.push(`Browser  : ${report.attach.detail}`)
  } else {
    lines.push(`Browser  : ${report.browser ?? 'none found'}`)
  }
  if (report.goalMode !== undefined) lines.push(`Goal mode: ${report.goalMode}`)
  for (const [label, value] of Object.entries(extra)) {
    lines.push(`${String(label).padEnd(9)}: ${value}`)
  }
  if (report.problems.length === 0) {
    lines.push('Status   : ready')
  } else {
    lines.push('Problems :')
    for (const item of report.problems) lines.push(`  - ${item.message}`, `    fix: ${item.fix}`)
  }
  return lines.join('\n')
}
