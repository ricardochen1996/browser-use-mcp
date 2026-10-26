/**
 * Finding a Python 3.12+ and building the managed environment from it.
 *
 * The engine is a Python package (`jev_ultrafast`) with its own Python dependencies
 * (`browser_harness`), and nothing npm installs builds a Python environment. So the server treats
 * the engine as a runtime prerequisite it checks and — when it owns the environment — builds:
 * this module is the bottom half of that, and answers three questions. Which `uv` exists, which
 * `uv`-managed or system Python exists, and can one of them create a virtualenv for the sidecar.
 *
 * `uv` is preferred because it is the cheap path in both directions: `uv venv --python 3.12` also
 * works on a machine with no suitable Python at all (uv may fetch one), and its `uv pip install`
 * reads the same hash-pinned requirements file as pip does. A Python 3.12+ with no uv is the other
 * supported shape: `python -m venv` plus pip. One rule matters more than the strategy: every
 * interpreter is **probed** before it is used, so a macOS `python3` stub, an app-store shim, or a
 * Python older than 3.12 is reported instead of being handed to `venv`.
 *
 * @module browser-use-mcp/python
 */

import { spawn } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The oldest Python the engine and its sidecar run on; both declare `>=3.12`. */
export const PYTHON_MINIMUM = '3.12'

const MINIMUM = [3, 12]

/** How long one interpreter has to answer the version probe before it is passed over. */
export const PROBE_TIMEOUT_MS = 15000

/** How long `python -m venv` may take when the caller names no budget. */
export const VENV_TIMEOUT_MS = 120000

/** How long uv may take: it is allowed to download a CPython before it creates the environment. */
export const UV_VENV_TIMEOUT_MS = 300000

/**
 * The Python uv is asked to create the managed environment with.
 *
 * A fixed version rather than the newest installed one: the requirements are pinned and tested on
 * 3.12, and uv finds that version on PATH or fetches it, so the same environment is built on every
 * machine instead of depending on which Pythons happen to be newest.
 */
export const ENVIRONMENT_PYTHON_VERSION = '3.12'

const PYTHON_INSTALLER = process.platform === 'win32'
  ? 'winget install Python.Python.3.12'
  : process.platform === 'darwin'
    ? 'brew install python@3.12'
    : 'your distribution\u2019s python3.12 package (apt install python3.12 python3.12-venv)'

const UV_INSTALLER = process.platform === 'win32'
  ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  : 'curl -LsSf https://astral.sh/uv/install.sh | sh (or brew install uv)'

/** The fix for "nothing on this machine can build the environment". */
const NOTHING_TO_BUILD_WITH = `install Python ${PYTHON_MINIMUM}+ (${PYTHON_INSTALLER}) or uv (${UV_INSTALLER})`

const PYTHON_VENV_FIX = `that Python cannot build a virtualenv: install its venv package (for example `
  + `python3.12-venv on Linux), or uv (${UV_INSTALLER})`

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The `uv` binary on PATH, or `undefined`.
 *
 * PATH is the only place it is looked for on purpose: an installer puts it somewhere the user's
 * shell can see, and inventing absolute locations would make the search depend on this machine.
 * (The Windows installer ships `uv.exe`, hence the platform name.)
 * @param {NodeJS.ProcessEnv} [env] - environment whose PATH is searched, `process.env` by default.
 * @returns {string|undefined}
 */
export function findUv(env = process.env) {
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv'
  for (const directory of String(env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * The interpreter inside a virtualenv.
 * @param {string} environment - the virtualenv directory.
 * @returns {string}
 */
export function environmentPython(environment) {
  return process.platform === 'win32'
    ? join(environment, 'Scripts', 'python.exe')
    : join(environment, 'bin', 'python')
}

/**
 * The interpreter names a stock machine may expose on PATH.
 *
 * Versioned names first, highest first: on POSIX the newest installed Python is the likeliest to
 * satisfy `>=3.12` and to be a real interpreter rather than a shim. Windows installs expose one
 * `python.exe` (the versioned names are a POSIX convention), which is also why the Windows path
 * can only ever use "the base Python".
 */
function systemPythonNames() {
  return process.platform === 'win32'
    ? ['python.exe']
    : ['python3.14', 'python3.13', 'python3.12', 'python3']
}

/**
 * The ways this machine can build the environment, best first, each with the reason it is here.
 *
 * The configured `pythonPath`, when there is one, is an explicit user choice and comes first. uv
 * comes next: it is not an interpreter — `probePython` must never be pointed at it — but it is the
 * cheapest environment builder, because `uv venv --python 3.12` pins the version instead of taking
 * whatever a PATH entry happens to be. The system Pythons come last, still in version order: they
 * are what a machine without uv has, and each is probed before `createEnvironment` uses it.
 *
 * There are no absolute paths in this list; every system candidate is resolved through PATH by the
 * spawn that probes it, which is what keeps the same code correct under Homebrew, pyenv, a Windows
 * installer, or a shell that prepends its own bin directory.
 * @param {object} [config] - resolved server configuration; only `config.pythonPath` is read.
 * @returns {{command: string, prefix: string[], source: string}[]}
 */
export function basePythons(config = {}) {
  const candidates = []
  const add = (command, prefix, source) => {
    if (candidates.some(item => item.command === command && item.prefix.join(' ') === prefix.join(' '))) return
    candidates.push({ command, prefix, source })
  }
  const configured = String(config.pythonPath ?? '').trim()
  if (configured !== '') add(configured, [], 'pythonPath')
  const uv = findUv()
  if (uv !== undefined) add(uv, [], 'uv')
  for (const name of systemPythonNames()) add(name, [], 'system python')
  return candidates
}

/** Whether a probe's version is new enough to run the engine. */
function supported(probe) {
  if (probe.major !== MINIMUM[0]) return probe.major > MINIMUM[0]
  return probe.minor >= MINIMUM[1]
}

/** What to ask an interpreter: its own version, in the shape the rest of this module reads. */
const VERSION_PROBE = [
  'import json, sys',
  'json.dump({"version": ".".join(str(part) for part in sys.version_info[:3]),',
  '           "major": sys.version_info[0], "minor": sys.version_info[1]}, sys.stdout)',
].join('\n')

/**
 * Ask one interpreter what version it is.
 *
 * The probe is deliberately tiny: spawning a Python is the expensive part, and an interpreter that
 * cannot answer this simple program cannot be trusted to build an environment either. Timeouts,
 * spawn failures, and nonzero exits all become a `failure` string, so a broken `python3` on PATH is
 * reported rather than thrown.
 * @param {string} command - interpreter to run (a path or a PATH name).
 * @param {string[]} [prefix] - arguments before `-c`, for launchers such as Windows' `py`.
 * @returns {Promise<{version: string, major: number, minor: number}|{failure: string}>}
 */
export function probePython(command, prefix = []) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, [...prefix, '-c', VERSION_PROBE], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ failure: `${command} could not be started: ${error.message}` })
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
      settle({ failure: `did not answer within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s` })
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.on('error', error => {
      settle({ failure: `${command} could not be started: ${error.message}` })
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
        settle({ failure: `answered something unreadable: ${out.slice(0, 120)}` })
        return
      }
      if (typeof report.major !== 'number' || typeof report.minor !== 'number'
          || typeof report.version !== 'string') {
        settle({ failure: `answered something unexpected: ${out.slice(0, 120)}` })
        return
      }
      settle({ version: report.version, major: report.major, minor: report.minor })
    })
  })
}

/**
 * One command, its output as lines, and how it ended.
 *
 * `timeoutMs` is the whole budget this command has: it is asked to stop, then killed. The caller
 * decides what an exit code means; this only reports what happened. Output is streamed through
 * `onLine` so an install can show progress without buffering everything until the end.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, onLine?: (line: string) => void, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number|undefined, signal: string|undefined, timedOut: boolean,
 *   spawnError: string|undefined}>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: undefined, signal: undefined, timedOut: false, spawnError: error.message })
      return
    }
    const pending = { stdout: '', stderr: '' }
    const take = (stream, chunk) => {
      const parts = (pending[stream] + String(chunk)).split(/\r\n|\r|\n/u)
      pending[stream] = parts.pop()
      for (const part of parts) {
        if (part === '') continue
        try {
          options.onLine?.(part)
        } catch {
          // A listener that throws is its own problem; the command goes on for everyone else.
        }
      }
    }
    child.stdout.on('data', chunk => take('stdout', chunk))
    child.stderr.on('data', chunk => take('stderr', chunk))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }, options.timeoutMs ?? VENV_TIMEOUT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: undefined, signal: undefined, timedOut: false, spawnError: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      for (const stream of ['stdout', 'stderr']) {
        if (pending[stream] !== '') {
          try {
            options.onLine?.(pending[stream])
          } catch {
            // As above: the command already finished.
          }
        }
      }
      resolve({ code, signal, timedOut, spawnError: undefined })
    })
  })
}

/** The environment `python -m venv` runs in: ours, minus anything that names another Python. */
function venvEnvironment() {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.VIRTUAL_ENV
  delete env.PYTHONHOME
  return env
}

/** A failed environment build, in the shape the install reports and the doctor repeat. */
function failure(code, error, fix) {
  return { ok: false, code, error, fix }
}

/** The last lines a builder printed, short enough to sit inside an error message. */
function lastWords(tail) {
  const lines = tail.map(line => line.trim()).filter(Boolean).slice(-2)
  if (lines.length === 0) return ''
  const text = lines.join(' | ')
  return `: ${text.length > 240 ? `${text.slice(0, 239)}\u2026` : text}`
}

/**
 * Remove the target environment before building it.
 *
 * A half-built environment from an earlier failed attempt, or a virtualenv built by a Python that
 * has since disappeared, is worse than no environment: `venv` and `uv venv` would both try to
 * repair a tree they did not create. This is this server's own directory, so clearing it is safe.
 */
function clearEnvironment(environment) {
  try {
    rmSync(environment, { recursive: true, force: true })
  } catch {
    // If it cannot be removed the builder reports that itself; failing to delete is not the error.
  }
}

/**
 * Create the environment with one base Python: `python -m venv`, then probe what it produced.
 * @param {string[]} tail - the builder's output so far; its last lines explain a failure.
 * @returns {Promise<object>} the create result, success or failure.
 */
async function createWithPython(candidate, probe, environment, say, tail) {
  const label = candidate.source === 'pythonPath' ? 'the configured Python' : 'a Python this machine has'
  say(`creating ${environment} with ${candidate.command} (${label}, Python ${probe.version})`)
  const result = await runCommand(candidate.command, [...candidate.prefix, '-m', 'venv', environment], {
    env: venvEnvironment(),
    onLine: say,
    timeoutMs: VENV_TIMEOUT_MS,
  })
  if (result.spawnError !== undefined) {
    return failure('venv_failed', `${candidate.command} could not be started: ${result.spawnError}`, PYTHON_VENV_FIX)
  }
  if (result.timedOut) {
    return failure('venv_failed',
      `${candidate.command} -m venv did not finish within ${Math.round(VENV_TIMEOUT_MS / 1000)}s`
      + lastWords(tail), PYTHON_VENV_FIX)
  }
  if (result.code !== 0) {
    return failure('venv_failed',
      `${candidate.command} -m venv exited with ${result.code ?? result.signal}${lastWords(tail)}`,
      PYTHON_VENV_FIX)
  }
  const inside = await probePython(environmentPython(environment))
  if (inside.failure !== undefined) {
    return failure('venv_failed',
      `${candidate.command} -m venv created ${environment}, but the interpreter in it did not answer: `
      + inside.failure,
      PYTHON_VENV_FIX)
  }
  if (!supported(inside)) {
    return failure('venv_failed',
      `${candidate.command} -m venv created ${environment} with Python ${inside.version}, older than `
      + `${PYTHON_MINIMUM}`, PYTHON_VENV_FIX)
  }
  return { ok: true, python: environmentPython(environment), strategy: 'python', pythonVersion: inside.version }
}

/**
 * Build the managed virtualenv, with uv when it exists and a probed Python 3.12+ otherwise.
 *
 * The two strategies are not equal: with uv the environment is created by a tool that can also
 * fetch the pinned Python, so a machine with no suitable interpreter still succeeds; without uv the
 * environment has to come from an interpreter already present. Both end in the same place — a
 * virtualenv whose own `python` answered the version probe — and every command's output is passed
 * to `onOutput` as it arrives, because a first install that downloads wheels has to show what it is
 * doing for those seconds.
 *
 * The configured `pythonPath` is the answer or the failure: uv is not used over an explicitly named
 * interpreter, because silently installing somewhere else would ignore the configuration.
 * @param {{config?: object, envDir: string, onOutput?: (line: string) => void}} options
 * @returns {Promise<{ok: true, python: string, strategy: 'uv'|'python', pythonVersion: string}
 *   | {ok: false, code: 'no_python'|'no_uv'|'venv_failed', error: string, fix: string}>}
 */
export async function createEnvironment({ config = {}, envDir, onOutput } = {}) {
  if (typeof envDir !== 'string' || envDir.trim() === '') {
    throw new TypeError('createEnvironment needs an envDir')
  }
  // The builder's output is streamed to the observer and its tail is kept for the failure message:
  // "exit status 1" alone is not a diagnosis, but the line before it often is.
  const tail = []
  const say = line => {
    tail.push(String(line))
    if (tail.length > 20) tail.shift()
    try {
      onOutput?.(line)
    } catch {
      // An observer that throws must not fail the install for everyone else.
    }
  }
  const configured = String(config.pythonPath ?? '').trim()
  if (configured !== '') {
    const probe = await probePython(configured)
    if (probe.failure !== undefined) {
      return failure('no_python',
        `the configured --python (${configured}) cannot be used: ${probe.failure}`,
        'correct --python, or clear it and the server builds an environment of its own')
    }
    if (!supported(probe)) {
      return failure('no_python',
        `the configured --python is Python ${probe.version}, older than ${PYTHON_MINIMUM}`,
        `${NOTHING_TO_BUILD_WITH}, or point --python at a newer interpreter`)
    }
    clearEnvironment(envDir)
    return createWithPython({ command: configured, prefix: [], source: 'pythonPath' }, probe, envDir, say, tail)
  }

  const uv = findUv()
  let uvFailure
  if (uv !== undefined) {
    say(`creating ${envDir} with uv (Python ${ENVIRONMENT_PYTHON_VERSION})`)
    clearEnvironment(envDir)
    const result = await runCommand(uv, ['venv', '--python', ENVIRONMENT_PYTHON_VERSION, envDir], {
      env: venvEnvironment(),
      onLine: say,
      timeoutMs: UV_VENV_TIMEOUT_MS,
    })
    if (result.spawnError !== undefined) {
      uvFailure = `${uv} could not be started: ${result.spawnError}`
    } else if (result.timedOut) {
      uvFailure = `uv venv did not finish within ${Math.round(UV_VENV_TIMEOUT_MS / 1000)}s`
    } else if (result.code !== 0) {
      uvFailure = `uv venv exited with ${result.code ?? result.signal}${lastWords(tail)}`
    } else {
      const inside = await probePython(environmentPython(envDir))
      if (inside.failure === undefined && supported(inside)) {
        return { ok: true, python: environmentPython(envDir), strategy: 'uv', pythonVersion: inside.version }
      }
      uvFailure = inside.failure === undefined
        ? `the interpreter uv created is Python ${inside.version}, older than ${PYTHON_MINIMUM}`
        : `the interpreter uv created did not answer: ${inside.failure}`
    }
    say(`uv could not create the environment (${uvFailure})`)
  }

  const candidates = basePythons(config).filter(item => item.source !== 'uv')
  const attempts = []
  for (const candidate of candidates) {
    const probe = await probePython(candidate.command, candidate.prefix)
    if (probe.failure !== undefined) {
      attempts.push(`${candidate.command} (${candidate.source}): ${probe.failure}`)
      continue
    }
    if (!supported(probe)) {
      attempts.push(`${candidate.command} (${candidate.source}): Python ${probe.version} `
        + `is older than ${PYTHON_MINIMUM}`)
      continue
    }
    clearEnvironment(envDir)
    const created = await createWithPython(candidate, probe, envDir, say, tail)
    if (created.ok === true) return created
    attempts.push(`${candidate.command} (${candidate.source}): ${created.error}`)
  }

  if (attempts.length === 0 && uvFailure === undefined) {
    return failure('no_python',
      `no Python ${PYTHON_MINIMUM}+ was found on PATH `
      + `(tried ${systemPythonNames().join(', ')}) and uv is not installed`,
      NOTHING_TO_BUILD_WITH)
  }
  const tried = attempts.length === 0 ? 'no usable base Python was found' : attempts.join('; ')
  const because = uvFailure === undefined ? '' : `uv could not build the environment (${uvFailure}) and `
  return failure('venv_failed', `${because}${tried}`, `${NOTHING_TO_BUILD_WITH}, then retry the install`)
}
