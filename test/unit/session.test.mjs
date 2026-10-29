/**
 * The session: observation numbering, the freshness guard's refusal, the operation queue, and the
 * profile/attachment claims — all without a browser, through a scripted sidecar.
 */

import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { resolveConfig } from '../../lib/config.js'
import { BrowserSession, FileLock, SessionBusy, SessionRefusal } from '../../lib/session.js'
import { daemonIdentity, daemonName, reapOrphanDaemons } from '../../lib/sidecar.js'

const HOME = mkdtempSync(join(tmpdir(), 'browser-use-mcp-session-'))
after(() => rmSync(HOME, { recursive: true, force: true }))

// Socket-budget fixtures live under /tmp because their *canonical* path is what the engine binds:
// on macOS that is /private/tmp, short enough to test both a fitting name and the digest fallback,
// while tmpdir() itself resolves to a long /private/var/... path. Every root is removed afterwards.
const tmpRoots = []
after(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true })
})
function tmpRoot(prefix = 'bu-rt-') {
  const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', prefix))
  tmpRoots.push(root)
  return root
}
/** A runtime directory whose symlink-resolved (what the engine binds) path is `length` bytes. */
function runtimePath(length) {
  const root = tmpRoot()
  const canonicalRoot = realpathSync(root)
  return join(root, 'x'.repeat(Math.max(1, length - canonicalRoot.length - 1)))
}

/** One page object, in the sidecar's observation shape. */
function page(fingerprint, extra = {}) {
  return { url: 'https://example.test/', title: 'Example', text: 'hello', fingerprint, elements: [], operations: { WAIT: [] }, ...extra }
}

/** A scripted stand-in for the real sidecar process. */
class FakeSidecar {
  constructor(handlers = {}) {
    this.handlers = handlers
    this.calls = []
    this.broken = false
    this.problem = ''
    this.readyCalls = 0
    this.stopped = []
    this.readyError = undefined
    this.warnings = []
  }

  async ready() {
    this.readyCalls += 1
    if (this.readyError) throw this.readyError
  }

  async request(method, params) {
    this.calls.push({ method, params })
    const handler = this.handlers[method]
    if (handler === undefined) throw new Error(`unexpected ${method}`)
    return handler(params)
  }

  async stop(options = {}) {
    this.stopped.push(options)
    return ''
  }
}

/** One session with a fake sidecar and a unique profile under the test home. */
function sessionFor({ handlers = {}, profile = `unit-${Math.random().toString(36).slice(2, 8)}`, extraFlags = {}, factory } = {}) {
  const config = resolveConfig({
    // Most tests are about a launched browser's profile; attach behaviour has its own describe block.
    flags: { mode: 'launch', browserUseMcpHome: HOME, profile, headless: true, ...extraFlags },
    env: {},
    cwd: HOME,
  })
  const fake = new FakeSidecar(handlers)
  const session = new BrowserSession({
    config,
    label: profile,
    sidecarFactory: () => fake,
    ...(factory === undefined ? {} : {}),
  })
  return { session, fake, config, profile }
}

describe('observations', () => {
  it('numbers observations and keeps the fingerprint of each', () => {
    const { session } = sessionFor()
    assert.equal(session.observed(page('a')), 1)
    assert.equal(session.observed(page('b')), 2)
    assert.equal(session.fingerprintFor(1), 'a')
    assert.equal(session.fingerprintFor('2'), 'b')
    assert.equal(session.fingerprintFor(99), undefined)
    assert.equal(session.last.observation, 2)
  })

  it('forgets the oldest observation once the bounded map is full', () => {
    const { session } = sessionFor()
    for (let index = 0; index < 60; index += 1) session.observed(page(`f${index}`))
    assert.equal(session.fingerprintFor(60), 'f59')
    assert.equal(session.fingerprintFor(10), undefined, 'observations beyond the bound are refused, not remembered')
  })
})

describe('open', () => {
  it('reports the observation and claims the profile', async () => {
    const { session, fake, config } = sessionFor({ handlers: { open: () => ({ page: page('open-1') }) } })
    const result = await session.open('https://example.test/')
    assert.equal(result.observation, 1)
    assert.equal(result.page.fingerprint, 'open-1')
    assert.equal(fake.calls[0].method, 'open')
    assert.equal(fake.calls[0].params.url, 'https://example.test/')
    assert.equal(fake.calls[0].params.userDataDir, config.userDataDir)
    assert.deepEqual(JSON.parse(readFileSync(join(config.userDataDir, '.browser-use-mcp.lock'), 'utf8')).pid, process.pid)
    await session.shutdown()
  })

  it('refuses a second session on the same profile instead of launching anything', async () => {
    const first = sessionFor({ profile: 'shared', handlers: { open: () => ({ page: page('one') }) } })
    await first.session.open('https://example.test/')
    const second = sessionFor({ profile: 'shared' })
    await assert.rejects(second.session.open('https://example.test/'), error => {
      assert.ok(error instanceof SessionBusy)
      assert.match(error.message, /already driven by another browser-use-mcp process/u)
      assert.equal(second.fake.calls.length, 0, 'a refused session never reaches the sidecar')
      return true
    })
    await first.session.shutdown()
  })

  it('reclaims a lock whose owning process is gone', async () => {
    const { session, config } = sessionFor({ profile: 'stale', handlers: { open: () => ({ page: page('x') }) } })
    mkdirSync(config.userDataDir, { recursive: true })
    writeFileSync(join(config.userDataDir, '.browser-use-mcp.lock'), JSON.stringify({ pid: 999_999, token: 'dead' }))
    const result = await session.open('https://example.test/')
    assert.equal(result.observation, 1)
    await session.shutdown()
  })

  it('reclaims the lock when the file is not readable json', async () => {
    const { session, config } = sessionFor({ profile: 'garbage', handlers: { open: () => ({ page: page('x') }) } })
    mkdirSync(config.userDataDir, { recursive: true })
    writeFileSync(join(config.userDataDir, '.browser-use-mcp.lock'), 'not json')
    await session.open('https://example.test/')
    await session.shutdown()
  })

  it('says once that a configured interpreter runs an engine this package does not ship', async () => {
    const { session, fake } = sessionFor({ handlers: { open: () => ({ page: page('one') }) } })
    fake.warnings = [{
      code: 'engine_outdated',
      message: 'the browser engine in use is jev_ultrafast 0.1.1, and this package ships 0.1.2',
      fix: 'install the bundled engine into that interpreter: uv pip install --python /tmp/py /pkg/engine.whl',
    }]
    const first = await session.open('https://example.test/')
    assert.match(first.note, /the browser engine in use is jev_ultrafast 0\.1\.1/u)
    assert.match(first.note, /fix: install the bundled engine/u)
    const second = await session.open('https://example.test/')
    assert.equal(second.note, '', 'the warning is said once per session')
    await session.shutdown()
  })

  it('keeps the engine warning when the first open fails', async () => {
    let attempts = 0
    const { session, fake } = sessionFor({
      handlers: {
        open: () => {
          attempts += 1
          if (attempts === 1) throw new Error('the browser could not be started')
          return { page: page('one') }
        },
      },
    })
    fake.warnings = [{
      code: 'engine_outdated',
      message: 'the browser engine in use is jev_ultrafast 0.1.1, and this package ships 0.1.2',
      fix: 'install the bundled engine into that interpreter',
    }]
    await assert.rejects(() => session.open('https://example.test/'), /could not be started/u)
    const second = await session.open('https://example.test/')
    assert.match(second.note, /the browser engine in use is jev_ultrafast 0\.1\.1/u, 'a failed open must not consume the one warning')
    await session.shutdown()
  })

  it('reports a previous generation that was not cleaned up', async () => {
    const { session, fake } = sessionFor({ handlers: { open: () => ({ page: page('x') }) } })
    fake.broken = true
    fake.problem = 'the browser exited'
    // A broken sidecar makes #sidecar bump the generation and start a new one through the factory.
    session.sidecar = { broken: true, problem: 'the browser exited', stop: async () => 'the browser exited' }
    const result = await session.open('https://example.test/')
    assert.match(result.note, /not shut down cleanly \(the browser exited\)/u)
    await session.shutdown()
  })
})

describe('act', () => {
  it('executes on the named observation and returns the new one', async () => {
    const { session, fake } = sessionFor({
      handlers: {
        open: () => ({ page: page('one') }),
        act: () => ({ executed: { operation: 'CLICK', label: 'Find stays' }, page: page('two') }),
      },
    })
    await session.open('https://example.test/')
    const result = await session.act({ observation: 1, operation: 'CLICK', target: '4' })
    assert.equal(result.observation, 2)
    assert.equal(result.executed.operation, 'CLICK')
    assert.equal(session.lastAction, 'CLICK on Find stays')
    assert.equal(fake.calls[1].params.fingerprint, 'one', 'the fingerprint of the named observation travels with the act')
    await session.shutdown()
  })

  it('refuses an observation this session never produced, without touching the browser', async () => {
    const { session, fake } = sessionFor({ handlers: { open: () => ({ page: page('one') }) } })
    await session.open('https://example.test/')
    await assert.rejects(session.act({ observation: 42, operation: 'CLICK', target: '1' }), error => {
      assert.ok(error instanceof SessionRefusal)
      assert.match(error.message, /observation 42 is not one this session produced/u)
      return true
    })
    assert.equal(fake.calls.length, 1, 'only the open reached the sidecar')
    await session.shutdown()
  })

  it('turns a stale answer into a refusal that carries the fresh table', async () => {
    const { session } = sessionFor({
      handlers: {
        open: () => ({ page: page('one') }),
        act: () => {
          throw Object.assign(new Error('The page changed since that observation. Choose from the new one.'), { kind: 'stale', page: page('fresh') })
        },
      },
    })
    await session.open('https://example.test/')
    await assert.rejects(session.act({ observation: 1, operation: 'CLICK', target: '4' }), error => {
      assert.ok(error instanceof SessionRefusal)
      assert.equal(error.kind, 'stale')
      assert.equal(error.page.fingerprint, 'fresh')
      assert.equal(error.observation, 2)
      assert.match(error.message, /The page changed/u)
      return true
    })
    assert.equal(session.fingerprintFor(2), 'fresh', 'the fresh observation is addressable')
    await session.shutdown()
  })

  it('reports a policy decision without an executed action', async () => {
    const { session } = sessionFor({
      handlers: {
        open: () => ({ page: page('one') }),
        act: () => ({ decision: { operation: 'DONE', target: '', label: '', confidence: 0.9 }, page: page('one') }),
      },
    })
    await session.open('https://example.test/')
    const result = await session.act({ observation: 1, intent: 'check it is done' })
    assert.equal(result.executed, undefined)
    assert.equal(result.decision.operation, 'DONE')
    assert.equal(session.lastAction, 'DONE')
    await session.shutdown()
  })

  it('serializes operations: the second act does not start before the first settles', async () => {
    let releaseFirst
    const order = []
    const { session } = sessionFor({ handlers: { open: () => ({ page: page('one') }) } })
    await session.open('https://example.test/')
    session.sidecar.request = async method => {
      if (method !== 'act') return { page: page('next') }
      order.push('start')
      if (order.length === 1) await new Promise(resolve => { releaseFirst = resolve })
      order.push('end')
      return { executed: { operation: 'CLICK', label: 'x' }, page: page(`p${order.length}`) }
    }
    const first = session.act({ observation: 1, operation: 'CLICK', target: '1' })
    const second = session.act({ observation: 1, operation: 'CLICK', target: '2' })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(order, ['start'], 'the second operation waits')
    releaseFirst()
    await Promise.allSettled([first, second])
    assert.deepEqual(order, ['start', 'end', 'start', 'end'])
    await session.shutdown()
  })

  it('maps a thrown expression in browser_eval to a refusal', async () => {
    const { session } = sessionFor({
      handlers: {
        open: () => ({ page: page('one') }),
        evaluate: () => {
          throw Object.assign(new Error('Error: boom'), { kind: 'js_error' })
        },
      },
    })
    await session.open('https://example.test/')
    await assert.rejects(session.evaluate({ expression: 'boom()' }), error => {
      assert.ok(error instanceof SessionRefusal)
      assert.match(error.message, /the expression threw/u)
      return true
    })
    await session.shutdown()
  })
})

describe('goal', () => {
  it('asks for no deadline: a goal run is as long as the policy needs', async () => {
    const { session: goalSession, fake } = sessionFor({ handlers: { open: () => ({ page: page('one') }) } })
    await goalSession.open('https://example.test/')
    let seenTimeout
    fake.request = async (method, params, signal, timeoutMs) => {
      seenTimeout = timeoutMs
      return { status: 'done', elapsed_ms: 1200, steps: 1, history: [], text_calls: [] }
    }
    const result = await goalSession.goal({ url: 'https://example.test/', goal: 'do it', engineEnv: {} })
    assert.equal(result.status, 'done')
    assert.equal(seenTimeout, Number.POSITIVE_INFINITY, 'no timer is armed for a goal request')
    await goalSession.shutdown()
  })

  it('needs a url and a goal', async () => {
    const { session: goalSession } = sessionFor()
    await assert.rejects(goalSession.goal({ url: '', goal: 'x' }), /needs a url/u)
    await assert.rejects(goalSession.goal({ url: 'https://a.test', goal: ' ' }), /needs a goal/u)
  })
})

describe('a lost generation', () => {
  it('forgets the page table of a sidecar that is gone, and starts a new generation', async () => {
    const { session, fake } = sessionFor({
      handlers: { observe: () => ({ page: page('fresh-generation') }) },
    })
    session.observed(page('old-generation'))
    session.lastAction = 'CLICK on something'
    session.sidecar = { broken: true, problem: 'the browser sidecar exited (1)', stop: async () => '' }
    const result = await session.observe()
    assert.equal(fake.readyCalls, 1, 'a new sidecar was made ready')
    assert.equal(result.page.fingerprint, 'fresh-generation')
    assert.match(session.problem, /browser sidecar exited/u, 'the caller can be told what happened')
    assert.equal(session.fingerprintFor(1), undefined, 'the dead generation’s observations are gone')
    await session.shutdown()
  })

  it('turns a vanished browser session from browser_page into an actionable refusal', async () => {
    const { session } = sessionFor({
      handlers: {
        open: () => ({ page: page('one') }),
        observe: () => {
          throw Object.assign(new Error('the browser daemon is gone. Call browser_open again.'), { kind: 'lost_session' })
        },
      },
    })
    await session.open('https://example.test/')
    await assert.rejects(session.observe(), error => {
      assert.ok(error instanceof SessionRefusal)
      assert.equal(error.kind, 'lost_session')
      assert.match(error.message, /browser_open again/u)
      return true
    })
    assert.equal(session.fingerprintFor(1), undefined, 'the page table of a lost session is forgotten')
    await session.shutdown()
  })
})

describe('close and shutdown', () => {
  it('closing with nothing open does not start a sidecar', async () => {
    const { session, fake } = sessionFor()
    const result = await session.close()
    assert.deepEqual(result, { closed: false, idle: true })
    assert.equal(fake.readyCalls, 0)
    assert.equal(session.sidecar, undefined)
  })

  it('close forgets the page but keeps the sidecar', async () => {
    const { session, fake } = sessionFor({
      handlers: {
        open: () => ({ page: page('one') }),
        close: () => ({ closed: true }),
      },
    })
    await session.open('https://example.test/')
    assert.deepEqual(await session.close(), { closed: true })
    assert.equal(session.last, null)
    assert.equal(session.fingerprintFor(1), undefined)
    assert.equal(fake.stopped.length, 0, 'the browser process is not stopped by browser_close')
    await session.shutdown()
  })

  it('shutdown releases the profile lock immediately, before the sidecar stops', async () => {
    const { session, fake, config } = sessionFor({
      handlers: { open: () => ({ page: page('one') }) },
    })
    await session.open('https://example.test/')
    const stopped = session.shutdown({ graceMs: 250 })
    assert.equal(existsSync(join(config.userDataDir, '.browser-use-mcp.lock')), false, 'the lock is gone before the stop resolves')
    await stopped
    assert.deepEqual(fake.stopped, [{ graceMs: 250 }])
  })
})

describe('attach sharing', () => {
  const endpoint = 'http://127.0.0.1:9/devtools'
  it('shared (the default) lets several sessions drive the same browser', async () => {
    const first = sessionFor({ profile: 'att-shared-a', extraFlags: { mode: 'attach', cdpEndpoint: endpoint }, handlers: { open: () => ({ page: page('a') }) } })
    const second = sessionFor({ profile: 'att-shared-b', extraFlags: { mode: 'attach', cdpEndpoint: endpoint }, handlers: { open: () => ({ page: page('b') }) } })
    await first.session.open('https://example.test/')
    await second.session.open('https://example.test/')
    assert.equal(existsSync(join(HOME, 'attachments')), false, 'shared attach takes no exclusive lock')
    await first.session.shutdown()
    await second.session.shutdown()
  })

  it('exclusive refuses the second session with a fix', async () => {
    const exclusive = { mode: 'attach', cdpEndpoint: endpoint, attachSharing: 'exclusive' }
    const first = sessionFor({ profile: 'att-excl-a', extraFlags: exclusive, handlers: { open: () => ({ page: page('a') }) } })
    await first.session.open('https://example.test/')
    const second = sessionFor({ profile: 'att-excl-b', extraFlags: exclusive })
    await assert.rejects(second.session.open('https://example.test/'), error => {
      assert.ok(error instanceof SessionBusy)
      assert.match(error.message, /--attach-sharing exclusive/u)
      return true
    })
    await first.session.shutdown()
  })
})

describe('daemon identity', () => {
  // A caller-supplied runtime directory whose canonical path is 50 bytes: short enough for the
  // default profile's full name, long enough that a 64-character label must fall back to the digest.
  // The shared switch keeps the daemon name in the file stem, which is what the server always sets.
  function shortEnv() {
    return { BH_RUNTIME_DIR: runtimePath(50), BH_RUNTIME_DIR_SHARED: '1' }
  }
  // Symlink-dependent fixtures and the AF_UNIX budget are POSIX-only.
  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('names the daemon after the session and the server process when the socket path fits', () => {
    const { name, files } = daemonIdentity(shortEnv(), 'default', 1)
    assert.equal(name, `browser-use-mcp-default-p${process.pid}`)
    assert.ok(files.sockPath.length <= 100, files.sockPath)
  })

  itPosix('keeps two server processes and two generations apart', () => {
    const first = daemonIdentity(shortEnv(), 'default', 1, 'p100')
    const second = daemonIdentity(shortEnv(), 'default', 1, 'p200')
    assert.equal(first.name, 'browser-use-mcp-default-p100')
    assert.notEqual(first.name, second.name, 'two server processes never own one daemon')
    assert.equal(daemonIdentity(shortEnv(), 'default', 1, 'p100').name, first.name, 'the name is stable for one process')
    assert.equal(daemonIdentity(shortEnv(), 'default', 2, 'p100').name, 'browser-use-mcp-default-p100-g2')
    assert.notEqual(daemonIdentity(shortEnv(), 'default', 2, 'p100').name, first.name, 'a generation is a different daemon')
  })

  it('keeps every daemon name inside Browser Harness\u2019s own 64-character limit', () => {
    // The label is already at Browser Harness's limit; the instance and generation tokens have to fit
    // inside it, not push the name past it, or the daemon cannot start at all.
    const name = daemonName('a'.repeat(64), 1_000)
    assert.ok(name.length <= 64, `${name.length}: ${name}`)
    assert.match(name, /^browser-use-mcp-a+-p\d+-g1000$/u)
  })

  itPosix('resolves the runtime directory through symlinks, the way the engine will', () => {
    // Browser Harness resolves the runtime directory before binding its socket, so /tmp on macOS is
    // /private/tmp there. The budget has to be spent on the same spelling, or it passes a path the
    // engine rejects with its opaque AF_UNIX error.
    const root = tmpRoot('bu-sym-')
    const target = join(root, 'real-runtime')
    mkdirSync(target, { recursive: true })
    const link = join(root, 'runtime-link')
    symlinkSync(target, link, 'dir')
    const direct = daemonIdentity({ BH_RUNTIME_DIR: target, BH_RUNTIME_DIR_SHARED: '1' }, 'default', 1)
    const viaLink = daemonIdentity({ BH_RUNTIME_DIR: link, BH_RUNTIME_DIR_SHARED: '1' }, 'default', 1)
    assert.equal(viaLink.name, direct.name)
    assert.equal(viaLink.files.sockPath, direct.files.sockPath)
    assert.ok(viaLink.files.sockPath.startsWith(realpathSync(target)), viaLink.files.sockPath)
    // A path whose real spelling cannot fit is reported with the variable that fixes it, not
    // accepted on the shorter spelling and then refused by the engine.
    const tooLong = join(link, 'x'.repeat(120))
    assert.throws(
      () => daemonIdentity({ BH_RUNTIME_DIR: tooLong, BH_RUNTIME_DIR_SHARED: '1' }, 'default', 1),
      /BH_RUNTIME_DIR/u,
    )
  })

  itPosix('falls back to a stable short digest instead of an AF_UNIX path that is too long', () => {
    // A 64-character label makes the full `<stem>-<instance>` name overflow sun_path even from this
    // 50-byte runtime directory, while the 10-character digest still fits.
    const longRuntime = { BH_RUNTIME_DIR: runtimePath(50), BH_RUNTIME_DIR_SHARED: '1' }
    const label = 'a'.repeat(64)
    const { name, files } = daemonIdentity(longRuntime, label, 1)
    assert.match(name, /^browser-use-mcp-[0-9a-f]{10}-p\d+$/u)
    assert.ok(files.sockPath.length <= 100, files.sockPath)
    // The same label, generation and server process must find the same daemon again; another one
    // must not collide.
    assert.equal(daemonIdentity(longRuntime, label, 1).name, name)
    assert.notEqual(daemonIdentity(longRuntime, label, 2).name, name)
    assert.notEqual(daemonIdentity(longRuntime, label.slice(0, -1), 1).name, name)
    assert.notEqual(daemonIdentity(longRuntime, label, 1, 'p999').name, name)
  })

  itPosix('refuses a runtime directory so long that no daemon name can fit, and names the fix', () => {
    const deep = { BH_RUNTIME_DIR: runtimePath(140), BH_RUNTIME_DIR_SHARED: '1' }
    assert.throws(() => daemonIdentity(deep, 'default', 1), /BH_RUNTIME_DIR/u)
  })
})

describe('orphan daemons', () => {
  /** One runtime directory of this test, with a daemon's four files in it. */
  function runtimeWith(name) {
    const runtime = join(HOME, name)
    mkdirSync(runtime, { recursive: true })
    return runtime
  }

  function writeDaemon(runtime, base, daemonPid) {
    writeFileSync(join(runtime, `${base}.pid`), `${daemonPid}\n`)
    writeFileSync(join(runtime, `${base}.sock`), '')
    writeFileSync(join(runtime, `${base}.port`), '')
    writeFileSync(join(runtime, `${base}.spawnlock`), '1')
  }

  it('removes daemons whose server process is gone, and only those', async () => {
    const runtime = runtimeWith('reap-runtime')
    const env = { BH_RUNTIME_DIR: runtime, BH_RUNTIME_DIR_SHARED: '1' }
    // A daemon an earlier server started and never stopped: its owner pid is dead, and the daemon
    // pid it published is dead too (it exited when its process group went away).
    writeDaemon(runtime, 'bu-browser-use-mcp-old-p999999', 999998)
    // A live server owns this one (this test process is the owner); generation suffix included.
    const live = `bu-browser-use-mcp-live-p${process.pid}-g2`
    writeDaemon(runtime, live, 999_997)
    // Files shaped like ours but without the owner token, and another tool's daemon, are not touched.
    writeFileSync(join(runtime, 'bu-browser-use-mcp-digest-p999996.sock'), '')
    writeFileSync(join(runtime, 'bu-default.pid'), '999995\n')
    writeFileSync(join(runtime, 'bu-browser-use-mcp-no-owner.sock'), '')

    const stopped = await reapOrphanDaemons(env)
    assert.deepEqual(stopped, [], 'nothing had a live daemon to signal')
    const left = readdirSync(runtime).sort()
    assert.deepEqual(left, [
      `${live}.pid`, `${live}.port`, `${live}.sock`, `${live}.spawnlock`,
      'bu-browser-use-mcp-no-owner.sock',
      'bu-default.pid',
    ].sort())
    assert.ok(!existsSync(join(runtime, 'bu-browser-use-mcp-old-p999999.pid')), 'the dead server\u2019s daemon files are gone')
    assert.ok(!existsSync(join(runtime, 'bu-browser-use-mcp-digest-p999996.sock')), 'a digest-named orphan is reaped too')
  })

  it('keeps a daemon whose published pid it cannot verify on the socket', async () => {
    // The owner server is gone, but something alive publishes itself as the daemon pid (a recycled
    // pid, or a daemon whose socket is gone). Nothing listens on the socket, so it must not be
    // signalled, and its files are left for a later, verifiable attempt.
    const runtime = runtimeWith('reap-unverified')
    const env = { BH_RUNTIME_DIR: runtime, BH_RUNTIME_DIR_SHARED: '1' }
    const base = 'bu-browser-use-mcp-unverified-p999994'
    writeDaemon(runtime, base, process.pid) // alive, but no socket behind it
    const stopped = await reapOrphanDaemons(env)
    assert.deepEqual(stopped, [])
    assert.ok(existsSync(join(runtime, `${base}.pid`)), 'an unverifiable daemon is left for a later attempt')
  })

  it('has nothing to do before the engine has created its runtime directory', async () => {
    const env = { BH_RUNTIME_DIR: join(HOME, 'reap-missing', 'runtime'), BH_RUNTIME_DIR_SHARED: '1' }
    assert.deepEqual(await reapOrphanDaemons(env), [])
  })
})

describe('FileLock', () => {
  it('is exclusive while a live process holds it and reclaims a dead holder', () => {
    const directory = join(HOME, 'locks')
    const path = join(directory, 'one.lock')
    const first = new FileLock(path)
    first.acquire(holder => new SessionBusy(`held by ${holder.pid}`, { fix: 'stop it' }))
    const second = new FileLock(path)
    assert.throws(() => second.acquire(holder => new SessionBusy(`held by ${holder.pid}`, { fix: 'stop it' })), SessionBusy)
    first.release()
    assert.throws(() => readFileSync(path, 'utf8'), /ENOENT/u)
    // A lock left by a dead pid is reclaimed.
    writeFileSync(path, JSON.stringify({ pid: 999_999, token: 'dead' }))
    second.acquire(holder => new SessionBusy(`held by ${holder.pid}`, { fix: 'stop it' }))
    second.release()
  })

  it('releasing a lock another process has replaced does not delete that one', () => {
    const path = join(HOME, 'locks', 'replaced.lock')
    const ours = new FileLock(path)
    ours.acquire(() => new SessionBusy('busy', { fix: 'no' }))
    writeFileSync(path, JSON.stringify({ pid: 999_998, token: 'someone-else' }))
    ours.release()
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'someone-else')
  })
})
