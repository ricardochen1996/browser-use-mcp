/**
 * One browser session: a sidecar generation, a serialized operation queue, and the observations a
 * caller's next action may refer to.
 *
 * The session is the unit an MCP connection owns. One MCP client gets one browser: its own profile,
 * its own DevTools connection, its own tabs. Two agents therefore never fight over a page by accident
 * — running two servers gives two browsers, and using the HTTP transport gives each MCP session its
 * own browser unless the server is told to share.
 *
 * @module browser-use-mcp/session
 */

import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { connectionFor } from './config.js'
import { Sidecar } from './sidecar.js'

/** The sidecar's own ceiling for one awaited expression (120 s), plus the answer's margin. */
export const EVAL_DEADLINE_MS = 125_000
/** How many past observations stay addressable by `browser_act`; a page is re-read after that. */
const MAX_OBSERVATIONS = 50

/** A refusal the caller can act on: nothing executed, and usually the fresh table to choose from. */
export class SessionRefusal extends Error {
  /**
   * @param {string} message - why nothing executed, or what to do instead.
   * @param {object} [options]
   * @param {object} [options.page] - the fresh page, when the refusal carries one.
   * @param {number} [options.observation] - the fresh observation number for `page`.
   * @param {string} [options.kind] - the sidecar's machine-readable refusal kind.
   */
  constructor(message, { page, observation, kind = 'refused' } = {}) {
    super(message)
    this.name = 'SessionRefusal'
    this.kind = kind
    this.page = page
    this.observation = observation
  }
}

/** Another live session holds the profile (or attached browser) this session was told to use. */
export class SessionBusy extends Error {
  constructor(message, { fix }) {
    super(message)
    this.name = 'SessionBusy'
    this.kind = 'busy'
    this.fix = fix
  }
}

let lockCounter = 0

/** One lock file: created exclusively, reclaimed when its owning process is gone, removed on release. */
export class FileLock {
  #path = null
  #token = null

  constructor(path) {
    this.#path = path
  }

  /**
   * Take the lock, or throw the busy error the caller supplies.
   * @param {(holder: object) => Error} busy - the refusal to throw when a live process holds it.
   */
  acquire(busy) {
    if (this.#path === null) return
    if (this.#token !== null) return // this session already holds it
    mkdirSync(join(this.#path, '..'), { recursive: true })
    const token = `${process.pid}-${Date.now()}-${++lockCounter}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(this.#path, 'wx')
        try {
          writeSync(descriptor, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }))
        } finally {
          closeSync(descriptor)
        }
        this.#token = token
        return
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const holder = this.#read()
        if (holder !== undefined && isAlive(holder.pid)) throw busy(holder)
        // The lock's owner is gone — a crashed server or one killed with its browser — so the
        // profile is free. Removing it is safe: the writer that could still be racing uses 'wx' too.
        try {
          unlinkSync(this.#path)
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError
        }
      }
    }
    throw busy(this.#read() ?? {})
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch {
      return undefined
    }
  }

  release() {
    if (this.#path === null || this.#token === null) return
    const holder = this.#read()
    if (holder?.token === this.#token) {
      try {
        unlinkSync(this.#path)
      } catch {
        // An already-removed lock needs nothing here.
      }
    }
    this.#token = null
  }
}

/** Whether a pid is alive on this machine; a permission answer counts as alive. */
function isAlive(pid) {
  const number = Number(pid)
  if (!Number.isInteger(number) || number <= 0) return false
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * One browser session.
 *
 * Every public operation is queued behind the session's earlier operations: a page is a shared piece
 * of state, and two tool calls racing on it is how a click lands on the wrong element. Cancellation
 * settles the wait, not the browser work — the page may already have changed, so the next call must
 * read it again rather than assume nothing happened.
 */
export class BrowserSession {
  /**
   * @param {object} options
   * @param {object} options.config - the resolved configuration.
   * @param {string} [options.label] - a filesystem-safe label for this session's browser.
   * @param {object} [options.logger] - the stderr logger.
   * @param {object} [options.connection] - per-session connection overrides (`userDataDir`, `headless`).
   * @param {(options: object) => object} [options.sidecarFactory] - how a sidecar generation is built;
   *   tests replace the real child process with a scripted one.
   */
  constructor({ config, label = 'session', logger, connection = {}, sidecarFactory }) {
    this.config = config
    this.label = label
    this.logger = logger
    this.connection = connectionFor(config, connection)
    this.generation = 1
    this.sidecar = undefined
    this.problem = ''
    this.tail = Promise.resolve()
    this.observation = 0
    this.fingerprints = new Map()
    this.last = null
    this.lastAction = ''
    this.openedAt = null
    this.#sidecarFactory = sidecarFactory ?? (sidecarOptions => new Sidecar(sidecarOptions))
    this.#profileLock = new FileLock(this.connection.mode === 'launch'
      ? join(this.connection.userDataDir, '.browser-use-mcp.lock')
      : null)
    // In attach mode, `shared` means several sessions (and several server processes) may drive the
    // browser you already use, each in its own tab and over its own daemon; `exclusive` claims the
    // DevTools endpoint for one live holder and refuses the rest.
    this.#attachLock = this.connection.mode === 'attach' && config.attachSharing === 'exclusive'
      ? new FileLock(join(config.browserUseMcpHome, 'attachments', `${createHash('sha256').update(this.connection.cdpEndpoint || 'discovered').digest('hex').slice(0, 16)}.lock`))
      : null
  }

  #profileLock
  #attachLock
  #sidecarFactory
  #engineWarningShown = false

  /** The sidecar this session may use now: the same generation while healthy, else a new one. */
  #sidecar() {
    if (this.sidecar && !this.sidecar.broken) return this.sidecar
    if (this.sidecar?.broken) {
      // The previous generation died or could not be cleaned up. It is never reused: the next browser
      // is a new process, a new daemon name, and the caller is told what happened. Its page table is
      // forgotten too — a table from a process that is gone is not an observation of anything now.
      this.problem = this.sidecar.problem || 'the browser sidecar was lost'
      this.generation += 1
      this.#forgetPage()
    }
    this.sidecar = this.#sidecarFactory({
      config: this.config,
      label: this.label,
      generation: this.generation,
      logger: this.logger,
    })
    return this.sidecar
  }

  /**
   * Run one browser operation after this session's earlier operations settle.
   * @param {AbortSignal} [signal] - cancellation for this one call.
   * @param {(sidecar: Sidecar, signal: AbortSignal) => Promise<any>} operation - the work to run.
   */
  run(signal, operation) {
    signal?.throwIfAborted?.()
    const task = this.tail.then(async () => {
      signal?.throwIfAborted?.()
      const sidecar = this.#sidecar()
      await sidecar.ready(signal)
      return operation(sidecar, signal)
    })
    this.tail = task.then(() => {}, () => {})
    return task
  }

  /**
   * Record one observation and return its number: the handle `browser_act` names.
   *
   * Only the last {@link MAX_OBSERVATIONS} stay addressable; an older observation is refused the same
   * way one this session never produced is, which is what keeps the fingerprint map bounded.
   */
  observed(page) {
    this.observation += 1
    this.fingerprints.set(this.observation, page.fingerprint)
    while (this.fingerprints.size > MAX_OBSERVATIONS) {
      this.fingerprints.delete(this.fingerprints.keys().next().value)
    }
    this.last = { page, observation: this.observation }
    return this.observation
  }

  /** The fingerprint of an observation this session produced, or undefined for a foreign one. */
  fingerprintFor(observation) {
    if (observation === undefined || observation === null) return undefined
    return this.fingerprints.get(Number(observation))
  }

  /** Forget page state, keeping the sidecar: the profile and the browser outlive one tab. */
  #forgetPage() {
    this.fingerprints.clear()
    this.last = null
    this.lastAction = ''
  }

  /** Take this session's claim on its browser; called before the first request that can launch one. */
  #claimConnection() {
    this.#profileLock?.acquire(holder => new SessionBusy(
      `browser profile "${this.config.profile}" at ${this.connection.userDataDir} is already driven by another `
      + `browser-use-mcp process (pid ${holder.pid}), so two servers would drive one browser. `
      + 'Stop that server, or give this one its own profile with --profile <name>.',
      { fix: 'start the other server with --profile <name>, or close it first' },
    ))
    this.#attachLock?.acquire(holder => new SessionBusy(
      `${this.connection.cdpEndpoint || 'the Chrome you browse with'} is already attached by another live `
      + `session or browser-use-mcp process (pid ${holder.pid}). With --attach-sharing exclusive only one `
      + 'holder is allowed; drop that flag (the default is shared) so both sessions can drive the browser '
      + 'in their own tabs, or launch a browser of our own with --mode launch.',
      { fix: 'stop the other server, or use --mode launch' },
    ))
  }

  /** Release the profile/attachment claim; the browser itself is stopped by `shutdown`. */
  #releaseConnection() {
    this.#profileLock?.release()
    this.#attachLock?.release()
  }

  /**
   * The engine warning this session has not shown yet, if any.
   *
   * `ensureEngine` compares the probed engine version with the wheel this package ships; the managed
   * environment is rebuilt when they differ, but a configured `--python` is the caller's own
   * interpreter and is only warned about. The doctor carries that warning; saying it once in the
   * first `browser_open` that succeeds is what reaches a caller that never calls the doctor. The
   * caller marks it shown only after the open request settles, so a failed first open does not
   * consume the one warning the session gets.
   * @param {Sidecar} sidecar - the generation this call runs on.
   */
  #engineWarningNote(sidecar) {
    if (this.#engineWarningShown) return ''
    const warning = (sidecar.warnings ?? []).find(item => item?.code === 'engine_outdated')
    return warning === undefined ? '' : `${warning.message}\nfix: ${warning.fix}`
  }

  /**
   * Open `url` in this session's browser and read it.
   * @returns {Promise<{page: object, observation: number, note: string}>}
   */
  async open(url, { signal, reuse = false } = {}) {
    if (typeof url !== 'string' || url.trim() === '') throw new SessionRefusal('browser_open needs a url.', { kind: 'bad_request' })
    // Claimed before the sidecar starts: a profile another process drives must not become a second
    // Chrome launch that only fails later, with the browser already up.
    this.#claimConnection()
    return this.run(signal, async sidecar => {
      // Read here, after the generation was chosen: a broken generation is replaced during the run,
      // and this call is the one that has to say the previous browser was not shut down cleanly.
      const notes = []
      if (this.problem) notes.push(`The previous browser was not shut down cleanly (${this.problem}); this is a new one.`)
      const engineNote = this.#engineWarningNote(sidecar)
      if (engineNote !== '') notes.push(engineNote)
      const note = notes.length === 0 ? '' : `\n\n${notes.join('\n\n')}\n`
      const { page } = await sidecar.request('open', {
        url: url.trim(),
        ...this.connection,
        ...(reuse ? { reuse: true } : {}),
      }, signal)
      if (engineNote !== '') this.#engineWarningShown = true
      this.problem = ''
      this.openedAt = Date.now()
      const observation = this.observed(page)
      return { page, observation, note }
    })
  }

  /** Read the current page again: a new observation for the same page. */
  async observe({ signal } = {}) {
    return this.run(signal, async sidecar => {
      try {
        const { page } = await sidecar.request('observe', {}, signal)
        const observation = this.observed(page)
        return { page, observation }
      } catch (error) {
        if (error?.kind === 'lost_session') {
          // The daemon or the tab behind the page is gone, so no table this session holds describes
          // anything now. Say which call fixes it instead of handing back the engine's raw error.
          this.#forgetPage()
          throw new SessionRefusal(
            `the browser session was lost (${error.message}). Call browser_open again; the next action must start from a fresh observation.`,
            { kind: 'lost_session' },
          )
        }
        throw error
      }
    })
  }

  /**
   * Run one guarded operation on one target of one observation.
   *
   * A stale page is reported as a refusal carrying the fresh table, never retried: the click the
   * caller chose was about to land somewhere it had not seen.
   * @param {object} input
   * @param {number} input.observation - the observation whose table the target came from.
   * @param {string} [input.operation] - `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_*`, `WAIT`.
   * @param {string} [input.target] - the target index from that observation.
   * @param {string} [input.text] - the value to enter when the operation is `TYPE_TEXT`.
   * @param {string} [input.intent] - what the step should accomplish, for the policy to choose.
   * @param {object} [input.engineEnv] - the Jev variables for this one model-spending call.
   */
  async act({ observation, operation = '', target = '', text, intent = '', engineEnv } = {}, { signal } = {}) {
    const fingerprint = this.fingerprintFor(observation)
    if (fingerprint === undefined) {
      throw new SessionRefusal(
        `observation ${observation ?? '(missing)'} is not one this session produced. Read the page again with browser_page.`,
        { kind: 'unsupported_target' },
      )
    }
    return this.run(signal, async sidecar => {
      try {
        const result = await sidecar.request('act', {
          operation,
          target,
          text,
          fingerprint,
          ...(intent === '' ? {} : { intent }),
          ...(engineEnv === undefined ? {} : { engine_env: engineEnv }),
        }, signal)
        const { page, ...rest } = result
        const fresh = this.observed(page)
        if (rest.executed !== undefined) {
          const label = rest.executed.label ? ` on ${rest.executed.label}` : ''
          this.lastAction = `${rest.executed.operation ?? operation}${label}`
        } else if (rest.decision !== undefined) {
          this.lastAction = rest.decision.operation ?? ''
        }
        return { ...rest, page, observation: fresh }
      } catch (error) {
        if (error?.kind === 'stale' && error.page) {
          const fresh = this.observed(error.page)
          throw new SessionRefusal(String(error.message), { page: error.page, observation: fresh, kind: 'stale' })
        }
        if (error?.kind === 'lost_session') {
          this.#forgetPage()
          throw new SessionRefusal(
            `the browser lost the page (${error.message}). Call browser_open again; the next action must start from a fresh observation.`,
            { kind: 'lost_session' },
          )
        }
        throw error
      }
    })
  }

  /**
   * Evaluate one JavaScript expression in the owned page over the session's own CDP connection.
   *
   * The expression gets no user gesture; a throw is reported as a refusal, and no observation is
   * produced because the page state is still the one the caller last read.
   */
  async evaluate({ expression, timeout_ms } = {}, { signal } = {}) {
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new SessionRefusal('browser_eval needs a JavaScript expression.', { kind: 'bad_request' })
    }
    return this.run(signal, async sidecar => {
      try {
        return await sidecar.request('evaluate', {
          expression,
          ...(timeout_ms === undefined ? {} : { timeout_ms }),
        }, signal, Math.max(this.config.requestTimeoutMs, EVAL_DEADLINE_MS))
      } catch (error) {
        if (error?.kind === 'js_error') {
          const message = String(error.message ?? '')
          throw new SessionRefusal(
            message.startsWith('the value cannot be returned by value')
              ? `the expression produced a value that cannot cross the wire by value:\n${message}`
              : `the expression threw, so nothing was returned:\n${message}`,
            { kind: 'js_error' },
          )
        }
        if (error?.kind === 'lost_session') {
          this.#forgetPage()
          throw new SessionRefusal(`the browser lost the page (${error.message}). Call browser_open again.`, { kind: 'lost_session' })
        }
        throw error
      }
    })
  }

  /** One JPEG of the visible viewport, as base64 plus its pixel size. */
  async screenshot({ quality, signal } = {}) {
    return this.run(signal, async sidecar => {
      const shot = await sidecar.request('screenshot', quality === undefined ? {} : { quality }, signal)
      return { jpegBase64: shot.jpeg_base64, width: shot.width, height: shot.height }
    })
  }

  /** Console entries, exceptions, failed and 4xx/5xx requests, drained per call. */
  async diagnostics({ signal } = {}) {
    return this.run(signal, async sidecar => sidecar.request('diagnostics', {}, signal))
  }

  /**
   * Hand a whole goal to the policy in its own tab. Spends model quota; never retried.
   * @param {object} input
   * @param {string} input.url - where the run starts.
   * @param {string} input.goal - what must be true when it finishes.
   * @param {object} [input.engineEnv] - the Jev variables for this one model-spending call.
   */
  async goal({ url, goal, engineEnv } = {}, { signal } = {}) {
    if (typeof url !== 'string' || url.trim() === '') throw new SessionRefusal('browser_goal needs a url.', { kind: 'bad_request' })
    if (typeof goal !== 'string' || goal.trim() === '') throw new SessionRefusal('browser_goal needs a goal.', { kind: 'bad_request' })
    this.#claimConnection()
    return this.run(signal, async sidecar => {
      // A goal run decides its own length: the policy loops until DONE/BLOCKED, which can exceed any
      // per-request deadline. The caller's client timeout is the real bound here.
      const result = await sidecar.request('goal', {
        url: url.trim(),
        goal: goal.trim(),
        ...this.connection,
        ...(engineEnv === undefined ? {} : { engine_env: engineEnv }),
      }, signal, Number.POSITIVE_INFINITY)
      return result
    })
  }

  /** Close the owned tab; a launched browser stays up for the next page. */
  async close({ signal } = {}) {
    // Nothing has been opened, so there is nothing to close and no reason to start a sidecar.
    if (this.sidecar === undefined) return { closed: false, idle: true }
    return this.run(signal, async sidecar => {
      const result = await sidecar.request('close', {}, signal)
      this.#forgetPage()
      return result
    })
  }

  /**
   * Release the profile/attachment claims *now*, without waiting for a browser.
   *
   * Locks are synchronous filesystem work and must be released even when the process dies a moment
   * later: a lock left by a killed server would refuse the next one until its owner pid is seen dead,
   * and that is a delay a user should never have to explain.
   */
  releaseLocks() {
    this.#releaseConnection()
  }

  /** Stop the sidecar (tab, browser, daemon) and release this session's claims. */
  async shutdown(options = {}) {
    // First, synchronously: whatever happens to this process next, the profile is not left claimed.
    this.#releaseConnection()
    const started = Date.now()
    const problem = await this.sidecar?.stop(options) ?? ''
    this.logger?.debug?.(`sidecar stopped in ${Date.now() - started}ms`)
    this.sidecar = undefined
    this.problem = problem
    this.#forgetPage()
    return problem
  }

  /** What the doctor shows about this session, without touching the browser. */
  status() {
    return {
      label: this.label,
      mode: this.connection.mode,
      generation: this.generation,
      sidecarRunning: this.sidecar !== undefined && !this.sidecar.broken,
      problem: this.problem,
      observation: this.observation,
      page: this.last ? { url: this.last.page.url, title: this.last.page.title ?? '', observation: this.last.observation } : null,
      lastAction: this.lastAction,
      openedAt: this.openedAt,
    }
  }
}
