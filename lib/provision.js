/**
 * Installing the engine this server drives: one environment the package owns, built once.
 *
 * Nothing npm installs builds a Python environment, so the engine is treated as a runtime
 * prerequisite: the package carries the engine as a wheel and its dependencies as hash-pinned
 * requirements, and the first caller that finds no engine builds the environment from them with a
 * Python the machine already has — or with uv, which can fetch the Python too. This module owns the
 * environment directory, the install itself, and the record of what was installed; `./engine.js`
 * decides when to call it.
 *
 * There is one environment per state root (`${BROWSER_USE_MCP_HOME}/env`), and there must be one
 * install at a time: two server processes starting together would otherwise both build the same
 * virtualenv. An in-process promise makes concurrent callers share one install, and an atomic lock
 * directory (`<stateRoot>/install.lock`, with the owner's pid inside) does the same across
 * processes. A lock whose owner is gone is reclaimed, so a killed install cannot wedge the next one.
 *
 * @module browser-use-mcp/provision
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEnvironment, environmentPython, findUv, runCommand } from './python.js'

/** This package's own root: the sidecar, the bundled engine, and the install hints live here. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The bundled engine wheel: parsed from its filename, so a version bump needs no code change. */
const VENDOR = join(PACKAGE_ROOT, 'vendor')

/** The requirements file the lock pins, one wheel per line with the hash of every artifact. */
const REQUIREMENTS = join(VENDOR, 'requirements.txt')

/** How long one install may take from lock to wheel, as the caller's hard cap. */
export const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** How often a waiter looks at the lock again. A build takes seconds, so this is cheap enough. */
const LOCK_POLL_MS = 400

/**
 * How long a lock directory without a readable owner is left alone.
 *
 * `mkdir` and writing `owner.json` are two steps: a waiter that read the directory in between would
 * see no owner and, without this grace period, could delete a lock that was just created and then
 * both processes would install. A few hundred milliseconds of patience is all it costs.
 */
const LOCK_GRACE_MS = 3000

/** The installer's output kept for the failure message; more is noise, less loses the cause. */
const KEPT_LINES = 40

/** The status fields observers see; the install's raw output and command stay internal. */
const STATUS_FIELDS = [
  'state', 'step', 'startedAt', 'finishedAt', 'environment', 'strategy', 'pythonVersion', 'error',
  'code', 'fix',
]

/** Environment dir -> the install running there in this process. */
const installs = new Map()

/** The in-process status of the last install this process ran, or `undefined` before one did. */
let status

/**
 * The state root: where the managed environment, the browser profiles, and the install record live.
 *
 * The configuration always resolves this, but a bare object still has to answer, so the documented
 * default is applied here too. The directory itself is created on demand by the install — a server
 * that only reads a report should not create anything.
 * @param {object} [config] - resolved server configuration.
 * @returns {string} the absolute state root.
 */
export function stateRoot(config = {}) {
  const configured = String(config.browserUseMcpHome ?? '').trim()
  return resolve(configured === '' ? join(homedir(), '.browser-use-mcp') : configured)
}

/**
 * The environment this server builds and owns: `<stateRoot>/env`.
 * @param {object} [config] - resolved server configuration.
 * @returns {string}
 */
export function ownEnvironment(config = {}) {
  return join(stateRoot(config), 'env')
}

/**
 * Where the install of the managed environment stands in this process, for observers such as the
 * doctor or a waiter that joined a running install.
 * @returns {{state: 'installing'|'installed'|'failed', step: string, startedAt: number,
 *   finishedAt?: number, environment: string, strategy?: string, pythonVersion?: string,
 *   error?: string, code?: string, fix?: string}|undefined} `undefined` before anything ran here.
 */
export function installStatus() {
  if (status === undefined) return undefined
  const copy = {}
  for (const key of STATUS_FIELDS) {
    if (status[key] !== undefined) copy[key] = status[key]
  }
  return copy
}

/** The install record path that belongs to an environment, whether or not the record exists yet. */
function installRecordPath(environment) {
  return join(dirname(environment), 'install.json')
}

/**
 * The record of what built an environment, written by this module on success, or `undefined`.
 *
 * The record lives beside the environment (`<stateRoot>/install.json`) rather than inside it: a
 * `python -m venv --clear` or a removed environment must not take the explanation of what happened
 * with it, and a later doctor in another process reads it without importing anything.
 * @param {string} environment - the managed virtualenv directory.
 * @returns {object|undefined}
 */
export function environmentRecord(environment) {
  try {
    const record = JSON.parse(readFileSync(installRecordPath(environment), 'utf8'))
    return record !== null && typeof record === 'object' ? record : undefined
  } catch {
    return undefined
  }
}

/** The hash-pinned requirements file for the sidecar's Python dependencies. */
export function requirementsPath() {
  return REQUIREMENTS
}

/**
 * The bundled engine wheel, its version read from the wheel's filename.
 *
 * Reading the version from the filename rather than a separate manifest means the record, the
 * doctor, and a version bump cannot disagree: they all describe the one file that is installed.
 * @param {string} [root] - package root to look in; the installed package by default.
 * @returns {{version: string, path: string}|undefined} `undefined` when no wheel ships here.
 */
export function bundledEngine(root = PACKAGE_ROOT) {
  const vendor = join(root, 'vendor')
  let names
  try {
    names = readdirSync(vendor)
  } catch {
    return undefined
  }
  const wheel = names.filter(name => /^jev_ultrafast-.+\.whl$/iu.test(name)).sort().at(-1)
  if (wheel === undefined) return undefined
  const version = wheel.split('-')[1]
  if (version === undefined || version === '') return undefined
  return { version, path: join(vendor, wheel) }
}

/** The version a requirement pins, so the install record can name browser-harness accurately. */
function requirementVersion(name) {
  try {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const match = new RegExp(`^${escaped}==([^\\s\\\\]+)`, 'mu').exec(readFileSync(REQUIREMENTS, 'utf8'))
    return match?.[1] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * How to ask for the install in this checkout, from a shell: the CLI command the package ships.
 * @param {object} [config] - resolved server configuration (accepted for call sites that have it).
 * @returns {string}
 */
export function installHint(config = {}) {
  void config
  return `node ${join(PACKAGE_ROOT, 'bin', 'browser-use-mcp.mjs')} install`
}

/** How to ask for the install again, appended to the end of a fix. */
function retryText(config) {
  return `retry: ${installHint(config)}`
}

/** A duration as a person reads it: `42s`, `3m`, `3m 5s`. */
export function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const rest = seconds % 60
  return rest === 0 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 60)}m ${rest}s`
}

/** The fix for "the installer could not reach the index", whatever it was downloading. */
function networkFix(config) {
  return `check the network (a proxy belongs in HTTPS_PROXY for the process that runs this server); then `
    + retryText(config)
}

/** The diagnosis, shortened: the first error lines the installer printed, or its last words. */
function summarize(lines) {
  const clipped = text => (text.length > 160 ? `${text.slice(0, 159)}\u2026` : text)
  const errors = lines.map(line => line.trim()).filter(line => /^(?:ERROR|error):/u.test(line))
  if (errors.length > 0) return [...new Set(errors.slice(-2))].map(clipped).join(' \u2014 ')
  return lines.map(line => line.trim()).filter(Boolean).at(-1) ?? ''
}

/** The npm/uv output that means the network, not the environment, is the problem. */
const NETWORK_FAILURE = new RegExp([
  'files\\.pythonhosted\\.org', 'pypi\\.org', 'error sending request', 'tcp connect', 'dns error',
  'connection (?:refused|reset)', 'timed out', 'tunnel error', 'certificate', 'network',
].join('|'), 'iu')

/** The fix for a failed install, decided by what the installer said. */
function fixFor(output, config) {
  const retry = retryText(config)
  if (/No matching distribution found|Could not find a version that satisfies/iu.test(output)) {
    return `the index did not carry the pinned versions: check the network, or point PIP_INDEX_URL (or `
      + `UV_INDEX_URL) at a mirror of PyPI; then ${retry}`
  }
  if (/THESE PACKAGES DO NOT MATCH THE HASHES|Expected sha256|hash mismatch/iu.test(output)) {
    return `an index served an artifact that is not the one requirements.txt records: point PIP_INDEX_URL `
      + `(or UV_INDEX_URL) at PyPI or a mirror of it; then ${retry}`
  }
  if (/No module named pip|ensurepip is not available|venv is not available/iu.test(output)) {
    return `that Python cannot build a virtualenv with pip: install its venv package (for example `
      + `python3.12-venv on Linux) or uv; then ${retry}`
  }
  if (/permission denied|read-only file system|operation not permitted/iu.test(output)) {
    return 'the state root (BROWSER_USE_MCP_HOME) has to be writable by the user this server runs as'
  }
  if (NETWORK_FAILURE.test(output)) {
    return networkFix(config)
  }
  return `fix what the installer reported; then ${retry}`
}

/** The environment pip and uv run in: the managed environment, and nothing that redirects them. */
function installEnvironment(environment) {
  const env = { ...process.env, VIRTUAL_ENV: environment, NO_COLOR: '1' }
  delete env.PIP_REQUIRE_VIRTUALENV
  delete env.PYTHONHOME
  return env
}

/**
 * The two commands that install with uv: the pinned dependencies, then the engine wheel from disk.
 *
 * uv validates the `--hash` lines in requirements.txt and, unlike a resolve, installs exactly what
 * the file lists. The wheel is installed `--no-deps` because its dependencies are already there,
 * which is what makes a first install about 1.3 MB instead of a full resolve.
 */
function uvInstallCommands(uv, environment, wheel) {
  const python = environmentPython(environment)
  return [
    {
      command: uv,
      args: ['pip', 'install', '--python', python, '-r', REQUIREMENTS],
      what: 'installing the pinned dependencies with uv',
    },
    {
      command: uv,
      args: ['pip', 'install', '--python', python, '--no-deps', wheel],
      what: 'installing the bundled engine',
    },
  ]
}

/** The same install with pip, for a machine without uv: hashes required, no dependencies resolved. */
function pipInstallCommands(environment, wheel) {
  const python = environmentPython(environment)
  const quiet = ['--no-input', '--disable-pip-version-check', '--progress-bar', 'off']
  return [
    {
      command: python,
      args: ['-m', 'pip', 'install', ...quiet, '--require-hashes', '--no-deps', '--only-binary=:all:',
        '-r', REQUIREMENTS],
      what: 'installing the pinned dependencies with pip',
    },
    {
      command: python,
      args: ['-m', 'pip', 'install', ...quiet, '--no-index', '--no-deps', wheel],
      what: 'installing the bundled engine',
    },
  ]
}

/** The lock directory that makes one install at a time a property of the state root. */
function lockPath(root) {
  return join(root, 'install.lock')
}

function readLockOwner(lock) {
  try {
    const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
    return owner !== null && typeof owner === 'object' && Number.isInteger(owner.pid) ? owner : undefined
  } catch {
    return undefined
  }
}

/** Whether a process id still names a live process; `EPERM` means alive but not ours. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Whether a lock may be removed: its owner is dead, or it never recorded an owner. */
function lockIsStale(lock) {
  const owner = readLockOwner(lock)
  // A readable owner is the fast path: a dead pid means the install was killed, and waiting for the
  // grace period would only delay the next one. The grace period exists for the unreadable case
  // below, where the directory may have been created a moment ago by a live installer.
  if (owner !== undefined) return !pidAlive(owner.pid)
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_GRACE_MS
  } catch {
    return true
  }
}

/** One attempt to take the lock: `mkdir` is atomic, the owner file explains who holds it. */
function tryLock(lock) {
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    const owner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    writeFileSync(join(lock, 'owner.json'), `${owner}\n`)
  } catch {
    // The lock is ours either way; an unreadable owner file only costs the reclaim grace period.
  }
  return true
}

function releaseLock(root) {
  try {
    rmSync(lockPath(root), { recursive: true, force: true })
  } catch {
    // A lock left behind is reclaimed by the next caller once this process is gone; never throw here.
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wait for the cross-process install lock, reclaiming a stale one, and fail after a hard cap.
 * @throws {Error} when another live install holds the lock for the whole budget.
 */
async function acquireInstallLock(root, config, onWait) {
  const lock = lockPath(root)
  const deadline = Date.now() + INSTALL_TIMEOUT_MS
  for (;;) {
    if (tryLock(lock)) return
    if (lockIsStale(lock)) {
      try {
        rmSync(lock, { recursive: true, force: true })
        continue
      } catch {
        // Another waiter may have reclaimed it first, or the directory refuses deletion; either way
        // fall through to the wait so an undeletable lock cannot become a hot loop.
      }
    }
    if (Date.now() >= deadline) {
      const owner = readLockOwner(lock)
      const who = owner === undefined ? 'another process' : `process ${owner.pid}`
      throw new Error(`${who} has held ${lock} for over ${duration(INSTALL_TIMEOUT_MS)}`)
    }
    onWait?.(`waiting for another install (${lock})`)
    await sleep(LOCK_POLL_MS)
  }
}

/** Write the record that tells a later process what built the environment. */
function writeInstallRecord(root, record) {
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'install.json'), `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // The environment works even when the convenience record cannot be written.
  }
}

/** A record that still describes a usable environment: one exists and its interpreter is there. */
function readyEnvironment(environment) {
  const record = environmentRecord(environment)
  if (record === undefined) return undefined
  if (!existsSync(environmentPython(environment))) return undefined
  return record
}

/** What a caller gets when the environment was already built: the same shape a fresh install has. */
function reusedResult(environment, record) {
  return {
    ok: true,
    environment: typeof record.environment === 'string' ? record.environment : environment,
    strategy: record.strategy,
    pythonVersion: record.pythonVersion,
    engine: record.engine,
    browserHarness: record.browserHarness,
  }
}

/**
 * Build the managed environment, or join the install already building it.
 *
 * The environment is reused when `install.json` records one and its interpreter exists — that is
 * what makes a second call, and a server restart, free. Whether the engine actually *imports* is
 * the caller's question (`inspectEngine` probes it); this module only builds and records. `force`
 * is the user asking for a clean rebuild, and is what a caller passes when a recorded environment
 * stopped working.
 *
 * Concurrent callers in this process share one promise and all receive the same result; another
 * process waits on the lock, and when it gets it re-checks for a finished install before building.
 * @param {object} [config] - resolved server configuration.
 * @param {{force?: boolean, onOutput?: (line: string) => void}} [options] - `onOutput` receives the
 *   installer's lines from now until this install ends, whichever caller started it.
 * @returns {Promise<{ok: boolean, environment: string, strategy?: string, pythonVersion?: string,
 *   engine?: string, browserHarness?: string, error?: string, code?: string, fix?: string,
 *   command?: string}>} the install's final state; it never rejects.
 */
export function installEngine(config = {}, options = {}) {
  const root = stateRoot(config)
  const environment = ownEnvironment(config)
  const force = options.force === true
  const current = installs.get(environment)
  if (current !== undefined) {
    if (typeof options.onOutput === 'function') current.listeners.add(options.onOutput)
    return current.promise
  }
  if (!force) {
    const record = readyEnvironment(environment)
    if (record !== undefined) return Promise.resolve(reusedResult(environment, record))
  }
  const listeners = new Set()
  if (typeof options.onOutput === 'function') listeners.add(options.onOutput)
  const entry = { listeners }
  installs.set(environment, entry)
  entry.promise = buildEnvironment({ config, root, environment, force, listeners })
    .finally(() => {
      if (installs.get(environment) === entry) installs.delete(environment)
    })
  return entry.promise
}

/** The actual install: status, lock, environment, two installs, record. */
async function buildEnvironment({ config, root, environment, force, listeners }) {
  const startedAt = Date.now()
  const output = []
  status = { state: 'installing', step: 'preparing the install', startedAt, environment }
  const say = text => {
    const line = String(text)
    if (line.trim() === '') return
    output.push(line)
    if (output.length > KEPT_LINES) output.shift()
    status.step = line.trim().slice(0, 200)
    for (const listener of listeners) {
      try {
        listener(line)
      } catch {
        // An observer that throws is its own problem; the install goes on for everyone else.
      }
    }
  }
  const failed = (code, error, fix) => {
    Object.assign(status, { state: 'failed', finishedAt: Date.now(), code, error, fix })
    return {
      ok: false,
      environment,
      strategy: status.strategy,
      pythonVersion: status.pythonVersion,
      error,
      code,
      fix,
      ...(status.command === undefined ? {} : { command: status.command }),
    }
  }
  const installed = record => {
    Object.assign(status, {
      state: 'installed',
      finishedAt: Date.now(),
      code: undefined,
      error: undefined,
      fix: undefined,
      // A waiter that reuses another process's install records that install's strategy, so the
      // doctor says how the environment was built even when this process did not build it.
      strategy: record.strategy,
      pythonVersion: record.pythonVersion,
    })
    return {
      ok: true,
      environment,
      strategy: record.strategy,
      pythonVersion: record.pythonVersion,
      engine: record.engine,
      browserHarness: record.browserHarness,
    }
  }

  try {
    mkdirSync(root, { recursive: true })
  } catch (error) {
    return failed('state_root_failed', `the state directory ${root} could not be created: ${error.message}`,
      `make ${root} writable by the user this server runs as, or set BROWSER_USE_MCP_HOME to a writable directory`)
  }
  try {
    await acquireInstallLock(root, config, text => { status.step = text })
  } catch (error) {
    return failed('lock_timeout', `another install never finished: ${error.message}`,
      `if no install is running, remove ${lockPath(root)} and retry: ${installHint(config)}`)
  }

  try {
    // Another process may have finished while this one waited; that install is the answer.
    if (!force) {
      const record = readyEnvironment(environment)
      if (record !== undefined) {
        status.step = 'another process already installed the environment'
        return installed(record)
      }
    }
    status.step = 'creating the virtualenv'
    const created = await createEnvironment({ config, envDir: environment, onOutput: say })
    if (created.ok !== true) {
      return failed(created.code, created.error, `${created.fix}; then ${retryText(config)}`)
    }
    status.strategy = created.strategy
    status.pythonVersion = created.pythonVersion
    const wheel = bundledEngine()
    if (wheel === undefined || !existsSync(wheel.path)) {
      return failed('no_wheel',
        `the engine wheel this package carries is missing: ${wheel?.path ?? join(VENDOR, 'jev_ultrafast-*.whl')}`,
        'reinstall the package: its Python half ships in vendor/ beside lib/')
    }
    const uv = findUv()
    const commands = uv === undefined
      ? pipInstallCommands(environment, wheel.path)
      : uvInstallCommands(uv, environment, wheel.path)
    for (const step of commands) {
      status.step = step.what
      status.command = `${step.command} ${step.args.join(' ')}`
      const remaining = Math.max(1000, INSTALL_TIMEOUT_MS - (Date.now() - startedAt))
      const result = await runCommand(step.command, step.args, {
        cwd: PACKAGE_ROOT,
        env: installEnvironment(environment),
        onLine: say,
        timeoutMs: remaining,
      })
      if (result.timedOut) {
        return failed('timeout', `${step.what} did not finish within ${duration(Date.now() - startedAt)}`,
          networkFix(config))
      }
      if (result.spawnError !== undefined) {
        return failed('install_failed', `${step.command} could not be started: ${result.spawnError}`,
          `check ${step.command}; then ${retryText(config)}`)
      }
      if (result.code !== 0) {
        return failed('install_failed',
          summarize(output) || `${step.command} exited with ${result.code ?? result.signal}`,
          fixFor(output.join('\n'), config))
      }
    }
    const record = {
      strategy: created.strategy,
      environment,
      pythonVersion: created.pythonVersion,
      installedAt: new Date().toISOString(),
      engine: wheel.version,
      browserHarness: requirementVersion('browser-harness'),
    }
    writeInstallRecord(root, record)
    return installed(record)
  } catch (error) {
    return failed('install_failed', `the install itself failed: ${error?.message ?? String(error)}`,
      `report this; then ${retryText(config)}`)
  } finally {
    releaseLock(root)
  }
}
