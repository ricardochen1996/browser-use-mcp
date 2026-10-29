/**
 * One sidecar process: line-delimited JSON over stdio, one browser session inside.
 *
 * A sidecar is a *generation*: when its browser cannot be shut down cleanly the process is abandoned
 * rather than reused, and the next browser this session opens gets a new generation with its own
 * daemon name. Reusing a half-dead daemon is how a "close then reopen" turns into a tool call that
 * fails for reasons nobody can see.
 *
 * Adapted from `dsh-browser-use` (`lib/sidecar.js`, MIT): the protocol is the vendored
 * `sidecar/bridge.py`'s, unchanged.
 *
 * @module browser-use-mcp/sidecar
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { ensureEngine, reportText, SIDECAR } from './engine.js'
import { ENGINE_VARIABLES } from './jev.js'

/** The largest delay `setTimeout` accepts; anything above it is clamped to 1 ms by Node. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * How long a daemon socket path may be.
 *
 * The engine's IPC is an AF_UNIX socket, and `sun_path` is 104 bytes on macOS (108 on Linux), NUL
 * included. A profile name is allowed to be long, and the daemon path is built from it, so the
 * budget is checked before a browser is ever started: the failure would otherwise surface as the
 * engine's opaque `fatal: AF_UNIX path too long` on every call.
 */
const SOCKET_PATH_BUDGET = 100

/** The error a cancelled request settles with; the browser may still complete what it started. */
export function cancelled(signal) {
  const error = new Error(
    'the operation was cancelled. The browser may still finish what it already started, '
    + 'so read the page again with browser_page before acting on it.',
  )
  error.kind = 'cancelled'
  if (signal?.reason !== undefined) error.cause = signal.reason
  return error
}

/** The error a call settles with when the engine environment could not be made ready. */
export class EngineNotReady extends Error {
  constructor(report) {
    super(`the browser engine is not ready.\n\n${reportText(report)}`)
    this.name = 'EngineNotReady'
    this.kind = 'engine'
    this.report = report
  }
}

/** The error a call settles with when the engine install it waited for was cancelled. */
export function cancelledInstall(signal) {
  const error = cancelled(signal)
  error.message = 'the operation was cancelled while it waited for the browser engine install. '
    + 'The install goes on: the next browser call waits for it, or uses what it installed.'
  return error
}

/**
 * Settle with `promise`, or with `failure(signal)` as soon as `signal` aborts.
 *
 * Only the wait is cancelled: the work behind `promise` goes on, and whoever asks for it next joins
 * it rather than starting it again.
 */
export function abortable(promise, signal, failure = cancelled) {
  if (signal === undefined || signal === null) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(failure(signal))
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure(signal))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** Browser Harness accepts a daemon name of at most this many characters (`[A-Za-z0-9_-]{1,64}`). */
const MAX_DAEMON_NAME = 64
/** Every daemon this server starts is named under this stem. */
const DAEMON_STEM = 'browser-use-mcp'

/**
 * The token that makes one server process's daemons distinct from another's.
 *
 * A label says which profile a daemon serves, and a generation says which browser this session opened
 * on it; neither says *which process* owns it. Two stdio servers configured with the same profile —
 * this app may start one server per session, and another MCP client one beside it — would otherwise
 * name one daemon, drive one tab, and either shutdown would stop the daemon under the other process,
 * which then answers every call with `FileNotFoundError`. The pid is the cheapest token that
 * separates them; it is read once, so every generation of this session names this process the same
 * way.
 */
const PROCESS_INSTANCE = `p${process.pid}`

/**
 * One daemon name from a stem, kept inside Browser Harness's own name limit.
 * @param {string} stem - the label (or its digest fallback), already restricted to safe characters.
 * @param {number} generation - 1 for the first browser this session opens.
 * @param {string} instance - the token that separates this server process from another one.
 */
function nameFromStem(stem, generation, instance) {
  const generationSuffix = generation <= 1 ? '' : `-g${generation}`
  const room = Math.max(
    1,
    MAX_DAEMON_NAME - DAEMON_STEM.length - 2 - instance.length - generationSuffix.length,
  )
  return `${DAEMON_STEM}-${stem.slice(0, room)}-${instance}${generationSuffix}`
}

/**
 * The daemon name one generation of one session owns.
 *
 * Browser Harness keeps a registration per name: a name a previous generation did not release
 * cleanly would be handed back to the next launch, so the generation suffix keeps that failure inside
 * the generation that caused it. The instance token keeps two server processes apart even when they
 * are configured with the same profile.
 * @param {string} label - the session's filesystem-safe label.
 * @param {number} generation - 1 for the first browser this session opens.
 * @param {string} [instance] - the server-process token; tests pass their own.
 */
export function daemonName(label, generation, instance = PROCESS_INSTANCE) {
  const stem = String(label).replace(/[^A-Za-z0-9_-]/gu, '') || 'session'
  return nameFromStem(stem, generation, instance)
}

/**
 * The environment a sidecar starts from: this process's, minus the engine's model variables.
 *
 * Jev's endpoints and keys travel with each request that spends them instead of living in the child,
 * and one stale key in the server's own environment must not become every run's key. Browser
 * Harness's shared-runtime switch is set when a runtime directory is inherited: several sessions may
 * share it, and the engine would otherwise collapse their daemon names to one.
 * @param {NodeJS.ProcessEnv} [source] - the environment to start from; `process.env` unless a caller says otherwise.
 */
export function inheritedEnvironment(source = process.env) {
  const env = { ...source }
  for (const name of ENGINE_VARIABLES) delete env[name]
  // One server may run several sidecars against one caller-supplied directory; Browser Harness would
  // otherwise collapse every daemon name to the bare `bu` stem and let one session find — and stop —
  // another session's daemon. Say the directory is shared whether it came in as BH_RUNTIME_DIR or as
  // the legacy BH_TMP_DIR (the engine treats the latter as the runtime directory too).
  if ((env.BH_RUNTIME_DIR || env.BH_TMP_DIR) && env.BH_RUNTIME_DIR_SHARED !== '1') {
    env.BH_RUNTIME_DIR_SHARED = '1'
  }
  if (env.BH_TMP_DIR && env.BH_TMP_DIR_SHARED !== '1') env.BH_TMP_DIR_SHARED = '1'
  return env
}

/** `~`/`~/…` expanded, the way the engine's own path handling does it. */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(1))
  return value
}

/**
 * The spelling of one directory that Browser Harness will actually bind.
 *
 * The engine resolves symlinks before it starts its daemon (`Path.resolve()`), so a runtime directory
 * reached through a link — `/tmp` on macOS is `/private/tmp` — is longer there than it is here. A
 * socket budget spent on the unresolved spelling passes a path the engine then rejects with its
 * opaque `fatal: AF_UNIX path too long`. Resolve the deepest part that exists and re-append the part
 * that does not, which is exactly what `Path.resolve()` does.
 * @param {string} path - an absolute path, which may end in directories that do not exist yet.
 */
function canonicalPath(path) {
  let current = path
  const missing = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Where Browser Harness keeps one daemon's pid and endpoint files.
 *
 * These are the engine's own documented conventions (`browser_harness/_ipc.py`, pinned by
 * `vendor/requirements.txt`): the runtime directory comes from `BH_RUNTIME_DIR`, then `BH_TMP_DIR`,
 * then `<config>/runtime`; the file stem is `bu-<name>` unless a caller-supplied runtime directory is
 * declared isolated by not setting the `_SHARED` switch. This server starts several sidecars, so it
 * always sets the shared switch and the stem always carries the daemon name.
 */
function daemonFiles(env, name) {
  const home = env.BH_HOME || env.BROWSER_HARNESS_HOME
    || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'browser-harness') : join(homedir(), '.config', 'browser-harness'))
  const caller = env.BH_RUNTIME_DIR || env.BH_TMP_DIR
  const runtime = canonicalPath(caller ? resolve(expandHome(caller)) : join(home, 'runtime'))
  const isolated = caller !== undefined && env.BH_RUNTIME_DIR_SHARED !== '1'
  const stem = isolated ? 'bu' : `bu-${name}`
  return {
    pidPath: join(runtime, `${stem}.pid`),
    sockPath: join(runtime, `${stem}.sock`),
    portPath: join(runtime, `${stem}.port`),
  }
}

/**
 * The daemon identity one session uses: its name and the files that name owns.
 *
 * A label long enough to push the socket path over the platform's `sun_path` limit is replaced by a
 * stable short digest (same label, generation and server process always give the same name, so a
 * restarted sidecar still finds the daemon it left). When even that cannot fit, the runtime directory
 * itself is the problem and the caller gets the variable that fixes it instead of the engine's opaque
 * error.
 * @param {object} env - the sidecar environment the runtime directory is read from.
 * @param {string} label - the session's filesystem-safe label.
 * @param {number} generation - 1 for the first browser this session opens.
 * @param {string} [instance] - the server-process token; tests pass their own.
 */
export function daemonIdentity(env, label, generation, instance = PROCESS_INSTANCE) {
  let name = daemonName(label, generation, instance)
  let files = daemonFiles(env, name)
  if (files.sockPath.length > SOCKET_PATH_BUDGET) {
    const digest = createHash('sha256').update(`${label}\u0000${generation}`).digest('hex').slice(0, 10)
    name = daemonName(digest, generation, instance)
    files = daemonFiles(env, name)
  }
  if (files.sockPath.length > SOCKET_PATH_BUDGET) {
    throw new Error(
      `the Browser Harness runtime directory is too long for a Unix socket `
      + `(${files.sockPath.length} > ${SOCKET_PATH_BUDGET} bytes): ${dirname(files.sockPath)}. `
      + 'Set BH_RUNTIME_DIR to a shorter directory, or move the state root closer to /.',
    )
  }
  return { name, files }
}

/** The pid Browser Harness published for one daemon, or undefined when it published none. */
function readDaemonPid(files) {
  try {
    const pid = Number(readFileSync(files.pidPath, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * Kill one orphaned daemon and drop the endpoint files it can no longer clean up itself.
 *
 * The bridge terminates the browser and then asks Browser Harness's admin layer to stop the daemon;
 * that clean path can spend fifteen seconds waiting for a daemon that is already wedged, and an MCP
 * client does not allow it. Once the browser is gone the daemon has nothing left to do, so a SIGTERM
 * to the pid it published is the same end the slow path would reach — without the wait, and without
 * leaving a process behind when this server exits. Every step is best effort: a daemon that already
 * exited is not an error.
 */
function stopDaemon(files, logger) {
  const pid = readDaemonPid(files)
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
      logger?.debug?.(`sent SIGTERM to orphaned browser-harness daemon ${pid}`)
      if (process.platform !== 'win32') {
        // A daemon that ignores SIGTERM must still be gone; the detached shell survives this process.
        spawn('/bin/sh', ['-c', `sleep 3; kill -9 ${pid} 2>/dev/null || true`], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      }
    } catch (error) {
      logger?.debug?.(`could not signal browser-harness daemon ${pid}: ${error?.message ?? error}`)
    }
  }
  for (const path of [files.pidPath, files.sockPath, files.portPath]) {
    try {
      unlinkSync(path)
    } catch {
      // Already cleaned by the daemon itself; nothing to do.
    }
  }
}

/** Whether the process a daemon file names is still running (EPERM means it exists, not ours). */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** The server-process pid encoded in one of this server's daemon file names, or undefined. */
function daemonOwnerPid(fileName) {
  const match = /^bu-browser-use-mcp-.+-p(\d+)(?:-g\d+)?\.(?:pid|sock|port|spawnlock)$/u.exec(fileName)
  if (match === null) return undefined
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * One daemon's answer to a ping on its own socket, or undefined when nothing answered.
 *
 * A ping is how a dead-owner daemon is identified before it is signalled: the pid published in a pid
 * file can be reused by an unrelated process, but only the real daemon answers with that same pid.
 * @param {string} sockPath - the daemon's AF_UNIX socket.
 * @param {number} [timeoutMs] - how long a silent daemon gets; reaping must never delay a browser call.
 */
function pingDaemon(sockPath, timeoutMs = 400) {
  return new Promise(resolve => {
    let settled = false
    let buffer = ''
    const socket = createConnection({ path: sockPath })
    const settle = answer => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => settle(undefined))
    socket.on('error', () => settle(undefined))
    socket.on('close', () => settle(undefined))
    socket.on('connect', () => socket.write('{"meta":"ping"}\n'))
    socket.on('data', chunk => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        settle(JSON.parse(buffer.slice(0, newline)))
      } catch {
        settle(undefined)
      }
    })
  })
}

/**
 * Stop Browser Harness daemons that server processes this machine killed never got to stop.
 *
 * A daemon is deliberately detached, so a server killed with SIGKILL cannot stop the one it started,
 * and the per-process daemon name means no later process can adopt it: the daemon would sit there
 * holding a CDP connection (and, in attach mode, one more "Allow remote debugging?" connection)
 * forever. Every server start therefore looks for daemons whose *owner* process is gone. A daemon is
 * only signalled after its own socket answers a ping with its published pid, so a recycled pid can
 * never turn cleanup into killing an unrelated process; daemons whose owner is alive are never
 * touched. Where the daemon cannot be verified, its files are left for a later attempt.
 * @param {object} environment - the sidecar environment the runtime directory comes from.
 * @param {object} [logger] - the stderr logger.
 * @returns {Promise<Array<{name: string, pid: number}>>} the daemons this call stopped.
 */
export async function reapOrphanDaemons(environment, logger) {
  // Windows daemons speak TCP loopback and publish a port/token file, not a socket that can be
  // pinged this way; reaping there would need the engine's token protocol, so it is left out.
  if (process.platform === 'win32') return []
  const runtime = dirname(daemonFiles(environment, 'browser-use-mcp').pidPath)
  let entries
  try {
    entries = readdirSync(runtime)
  } catch {
    return [] // the engine has not created its runtime directory yet: nothing to reap
  }
  const bases = new Map()
  for (const entry of entries) {
    const ownerPid = daemonOwnerPid(entry)
    if (ownerPid === undefined) continue
    const dot = entry.lastIndexOf('.')
    if (dot <= 0) continue
    const base = entry.slice(0, dot)
    if (!bases.has(base)) bases.set(base, { ownerPid, files: [] })
    bases.get(base).files.push(entry)
  }
  // Read every candidate first, then ping them together: reaping must cost one bounded wait, not one
  // per orphan, or a crash-heavy state root would slow the next server's first browser call.
  const candidates = []
  for (const [base, { ownerPid, files }] of bases) {
    if (processAlive(ownerPid)) continue // that server is running and owns its daemon
    let daemonPid
    try {
      const pid = Number(readFileSync(join(runtime, `${base}.pid`), 'utf8').trim())
      daemonPid = Number.isInteger(pid) && pid > 0 ? pid : undefined
    } catch {
      daemonPid = undefined
    }
    const unverifiable = daemonPid !== undefined && processAlive(daemonPid)
    candidates.push({ base, files, daemonPid, unverifiable })
  }
  const answers = await Promise.all(candidates.map(candidate =>
    candidate.unverifiable ? pingDaemon(join(runtime, `${candidate.base}.sock`)) : undefined))
  const stopped = []
  candidates.forEach((candidate, index) => {
    const { base, files, daemonPid } = candidate
    let cleaned = !candidate.unverifiable
    if (candidate.unverifiable && answers[index]?.pid === daemonPid) {
      try {
        process.kill(daemonPid, 'SIGTERM')
        logger?.debug?.(`reaped orphaned browser-harness daemon ${daemonPid} (${base})`)
        stopped.push({ name: base, pid: daemonPid })
        cleaned = true
      } catch (error) {
        logger?.debug?.(`could not reap browser-harness daemon ${daemonPid}: ${error?.message ?? error}`)
      }
    } else if (candidate.unverifiable) {
      logger?.debug?.(`left ${base}: its daemon pid ${daemonPid} could not be verified on its socket`)
    }
    if (!cleaned) return
    for (const file of files) {
      try {
        unlinkSync(join(runtime, file))
      } catch {
        // Already gone, or taken by a daemon that is finishing its own cleanup; both are fine.
      }
    }
  })
  return stopped
}

/** One sidecar process and the request/answer bookkeeping around it. */
export class Sidecar {
  #child = null
  #interpreter = null
  #lines = null
  #pending = new Map()
  #sequence = 0
  #stderr = []
  #problem = ''
  #daemon = null
  #warnings = []

  /**
   * @param {object} options
   * @param {object} options.config - the resolved configuration.
   * @param {string} options.label - a filesystem-safe label for this session.
   * @param {number} [options.generation] - which generation of this session's browser it is.
   * @param {object} [options.logger] - the stderr logger.
   */
  constructor({ config, label, generation = 1, logger }) {
    this.config = config
    this.label = label
    this.generation = generation
    this.logger = logger
  }

  /** Why this generation must not be reused, or an empty string while it is healthy. */
  get problem() {
    return this.#problem
  }

  /** The engine report's warnings (a stale `--python` engine, for instance); empty when none. */
  get warnings() {
    return this.#warnings
  }

  /** Whether this generation still owns a usable process. */
  get broken() {
    return this.#problem !== ''
  }

  /** The interpreter the sidecar runs on, once a call has made it ready. */
  get interpreter() {
    return this.#interpreter
  }

  /**
   * Check the engine, install it if this server owns its environment and finds none, then start the
   * sidecar.
   * @param {AbortSignal} [signal] - cancels this call's wait; an install it started goes on.
   */
  async ready(signal) {
    if (this.broken) throw new Error(`this browser could not be cleaned up (${this.#problem})`)
    const report = await abortable(ensureEngine(this.config), signal, cancelledInstall)
    if (!report.ok) throw new EngineNotReady(report)
    // The probe already found the interpreter that imports the engine: the sidecar runs on that one
    // rather than on a second guess made here.
    this.#interpreter = report.interpreter
    this.#warnings = Array.isArray(report.warnings) ? report.warnings : []
    await this.start()
  }

  async start() {
    if (this.#child) return
    const { command, prefix = [], cwd } = this.#interpreter ?? {}
    if (!command) throw new Error('the browser engine probe found no interpreter to run the sidecar')
    const environment = inheritedEnvironment()
    // A server killed with SIGKILL could not stop the daemon it started; clear those before this
    // generation claims a name of its own, so a hard kill does not leak one CDP connection per crash.
    await reapOrphanDaemons(environment, this.logger)
    // One daemon owns one CDP connection, and Browser Harness names its daemon when it imports.
    const { name, files } = daemonIdentity(environment, this.label, this.generation)
    const env = {
      ...environment,
      PYTHONUNBUFFERED: '1',
      BU_NAME: name,
    }
    this.#daemon = { name, files }
    const child = spawn(command, [...prefix, SIDECAR], {
      cwd: cwd || undefined,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child = child
    this.#lines = createInterface({ input: child.stdout })
    this.#lines.on('line', line => this.#answered(line))
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      this.#stderr.push(text)
      if (this.#stderr.length > 40) this.#stderr.shift()
      this.logger?.debug?.(`sidecar stderr: ${text.trim()}`)
    })
    child.on('error', error => {
      // An exit this session did not ask for (stop() clears #child first) means the generation is
      // unusable: reusing its process, daemon name, or page is how a crash turns into a call that
      // fails for reasons nobody can see.
      const unexpected = this.#child === child
      this.#child = null
      if (unexpected) this.#problem = `the browser sidecar could not be started: ${error.message}`
      this.#fail(new Error(`the browser sidecar could not be started: ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      const detail = this.#stderr.join('').trim().slice(-600)
      const unexpected = this.#child === child
      this.#child = null
      const message = `the browser sidecar exited (${code ?? signal})${detail ? `: ${detail}` : ''}`
      if (unexpected) {
        this.#problem = message
        // The sidecar is gone, but the Browser Harness daemon it started may still be running and
        // holding a socket. This generation is never reused, so nothing else would ever stop it: a
        // crash must not leave one Python process behind per session.
        if (this.#daemon !== null) stopDaemon(this.#daemon.files, this.logger)
      }
      this.#fail(new Error(message))
    })
    try {
      await this.request('hello', {}, undefined, 120_000)
    } catch (error) {
      // A sidecar that cannot even greet is stopped here, so no half-started process is left behind.
      await this.stop()
      throw error
    }
  }

  #fail(error) {
    for (const [, entry] of this.#pending) entry.reject(error)
    this.#pending.clear()
  }

  #answered(line) {
    let answer
    try {
      answer = JSON.parse(line)
    } catch {
      return // a non-JSON line is the sidecar's own noise, never a protocol answer
    }
    const entry = this.#pending.get(answer.id)
    if (!entry) return
    if (answer.error) {
      const error = Object.assign(new Error(answer.error.message ?? 'refused'), answer.error)
      error.kind = answer.error.kind
      entry.reject(error)
    } else {
      entry.resolve(answer.result)
    }
  }

  /**
   * Send one request and settle it on the answer, the deadline, cancellation, or process death.
   * @param {string} method - engine method name.
   * @param {object} params - engine parameters.
   * @param {AbortSignal} [signal] - the tool call's cancellation signal; aborting settles this promise only.
   * @param {number} [timeoutMs] - deadline for this one request.
   */
  request(method, params = {}, signal, timeoutMs = this.config.requestTimeoutMs) {
    const child = this.#child
    if (!child) return Promise.reject(new Error('the browser sidecar is not running'))
    if (signal?.aborted) return Promise.reject(cancelled(signal))
    const id = ++this.#sequence
    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = next => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        next()
      }
      const onAbort = () => finish(() => reject(cancelled(signal)))
      // `Infinity` (or any delay a timer cannot carry) means "no deadline": arming a timer with it
      // would do the opposite, because Node clamps an oversized delay to one millisecond. A goal run
      // is the caller that means this; its real bound is the MCP client's own timeout.
      if (Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS) {
        timer = setTimeout(() => {
          finish(() => reject(new Error(`${method} did not answer within ${timeoutMs}ms`)))
        }, timeoutMs)
      }
      this.#pending.set(id, {
        resolve: value => finish(() => resolve(value)),
        reject: error => finish(() => reject(error)),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  /**
   * Ask the engine to stop the tab, the browser, and the daemon, then make sure the process is gone.
   *
   * The bridge terminates the launched browser *before* it stops the Browser Harness daemon, and that
   * daemon cleanup can take fifteen seconds on this version. An MCP client closes a stdio server in
   * about four, so waiting for the whole shutdown is not an option: the grace below covers the part
   * that matters (the browser is gone within a few hundred milliseconds), and the sidecar is then
   * killed while the daemon finishes on its own. A shutdown the engine reports as failed still marks
   * this generation unusable, because the browser may not have been terminated.
   * @param {object} [options]
   * @param {number} [options.graceMs] - how long to wait for the engine's answer and its exit.
   * @returns {Promise<string>} the shutdown problem, or an empty string when it ended as expected.
   */
  async stop({ graceMs = 1_000 } = {}) {
    const child = this.#child
    if (!child) {
      // A sidecar that died asynchronously is reaped by its exit handler; this is the belt-and-braces
      // path for a crash the handler could not finish, so a crashed generation does not leak a daemon.
      if (this.#daemon !== null) stopDaemon(this.#daemon.files, this.logger)
      return this.#problem
    }
    const began = Date.now()
    try {
      await this.request('shutdown', {}, undefined, graceMs)
      this.logger?.debug?.(`sidecar shut down in ${Date.now() - began}ms`)
    } catch (error) {
      // A client that closes fast leaves the daemon cleanup running; it does not mean the browser is
      // still there — the bridge terminated it before starting that cleanup.
      this.logger?.debug?.(`sidecar shutdown did not answer in ${graceMs}ms: ${error?.message ?? error}`)
    }
    this.#child = null
    this.#fail(new Error('the browser sidecar was closed'))
    let killed = false
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      const ended = new Promise(resolve => child.once('exit', resolve))
      // The answer already told us whether the browser got its terminate; a sidecar still alive here
      // is finishing the daemon cleanup and can be killed without harming the browser.
      const exited = await Promise.race([
        ended.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 400)),
      ])
      if (!exited && child.exitCode === null) {
        killed = true
        child.kill('SIGKILL')
      }
    }
    // Whether this stop killed the sidecar or it managed to exit, this generation owns a daemon that
    // must not outlive it; stopDaemon is best effort and idempotent.
    if (this.#daemon !== null) stopDaemon(this.#daemon.files, this.logger)
    if (this.#problem === '' && child.exitCode !== 0 && child.signalCode !== null && child.signalCode !== 'SIGKILL') {
      this.#problem = `the sidecar was killed with ${child.signalCode}`
    }
    return this.#problem
  }
}
