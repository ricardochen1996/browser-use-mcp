/**
 * The session: observation numbering, the freshness guard's refusal, the operation queue, and the
 * profile/attachment claims — all without a browser, through a scripted sidecar.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { resolveConfig } from '../../lib/config.js'
import { BrowserSession, FileLock, SessionBusy, SessionRefusal } from '../../lib/session.js'

const HOME = mkdtempSync(join(tmpdir(), 'browser-use-mcp-session-'))
after(() => rmSync(HOME, { recursive: true, force: true }))

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
    flags: { browserUseMcpHome: HOME, profile, headless: true, ...extraFlags },
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

describe('close and shutdown', () => {
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
