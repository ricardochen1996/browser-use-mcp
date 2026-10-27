/**
 * End-to-end: attach mode against a Chrome this test launches itself.
 *
 * The browser is started here with `--remote-debugging-port` and its own throwaway profile, exactly
 * as a person's Chrome would be started for `chrome://inspect` remote debugging. The server is then
 * told `--mode attach --cdp-endpoint http://127.0.0.1:<port>`: it must drive that browser without
 * ever owning it — closing the tab it opened must not close the browser, and the Chrome process must
 * still be running after the servers are gone (this test kills it in its cleanup). With
 * `--attach-sharing exclusive` a second server on the same endpoint is refused; with the default
 * (shared) two servers may drive the browser at once, each in its own tab.
 *
 * No model calls: every outcome is read back from a later observation, and the only network traffic
 * is on loopback (the test's `/json/version` probes and the engine's CDP connection).
 *
 * Run with: node test/e2e/attach.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(ROOT, 'bin', 'browser-use-mcp.mjs')
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'fixture.html')).href
const STATE_ROOT = process.env.BROWSER_USE_MCP_TEST_HOME || join(tmpdir(), 'browser-use-mcp-e2e-home')
const PROFILE = 'e2e-attach'
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const passed = []

/** The environment every server child starts with: a test state root, no model keys. */
function serverEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(TYPESAFE_|TEXT_MODEL_|JEV_)/u.test(name)) delete env[name]
  }
  return {
    ...env,
    BROWSER_USE_MCP_HOME: STATE_ROOT,
    BROWSER_USE_MCP_PROFILE: PROFILE,
    BROWSER_USE_MCP_LOG_LEVEL: 'info',
    ...extra,
  }
}

/** The Chrome executable this machine has; macOS application bundle first, then PATH names. */
function chromeExecutable() {
  for (const candidate of [
    process.env.BROWSER_USE_MCP_TEST_CHROME,
    MAC_CHROME,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error('no Chrome or Chromium executable found for the attach test')
}

/** One free loopback TCP port, so parallel runs and the user's Chrome never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** GET one loopback URL without a proxy: a system proxy must not decide what this test sees. */
function getLoopback(path) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port: path.port, path: path.path, agent: false }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(JSON.parse(body))
        } catch (error) {
          reject(error)
        }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('no answer within 2s')))
    request.on('error', reject)
  })
}

/** The browser's `/json/version` answer, or undefined while it is not up. */
async function version(port) {
  try {
    return await getLoopback({ port, path: '/json/version' })
  } catch {
    return undefined
  }
}

/** Wait until the browser publishes its DevTools endpoint. */
async function waitForVersion(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const answer = await version(port)
    if (typeof answer?.webSocketDebuggerUrl === 'string' && answer.webSocketDebuggerUrl !== '') return answer
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Chrome never published /json/version on port ${port}`)
}

/** Whether a pid still exists on this machine. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Wait until a pid is gone, so a test can prove a browser or server process ended. */
async function waitGone(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** Launch the browser this test attaches to, and return its child plus the DevTools endpoint. */
async function launchChrome(port, userDataDir) {
  const child = spawn(chromeExecutable(), [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const stderr = []
  child.stderr.on('data', chunk => stderr.push(String(chunk)))
  try {
    await waitForVersion(port)
  } catch (error) {
    child.kill('SIGKILL')
    throw new Error(`${error.message}\nChrome said:\n${stderr.join('').slice(-2_000)}`)
  }
  return { child, stderr: () => stderr.join('') }
}

/** Stop the browser this test launched; every step is best effort and bounded. */
async function stopChrome(launched) {
  const child = launched?.child
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  if (!await waitGone(child.pid, 10_000)) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    await waitGone(child.pid, 5_000)
  }
}

/**
 * One server child plus the MCP client on it, attached to one DevTools endpoint.
 * @param {number} port - the Chrome DevTools port.
 * @param {object} [options]
 * @param {'exclusive'|'shared'|null} [options.sharing] - `exclusive` (the assertions about the
 *   ownership lock), `shared`, or `null` to pass no flag and exercise the default.
 */
async function startServer(port, { sharing = 'exclusive' } = {}) {
  const endpoint = `http://127.0.0.1:${port}`
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      BIN, '--mode', 'attach', '--cdp-endpoint', endpoint,
      ...(sharing === null ? [] : ['--attach-sharing', sharing]),
    ],
    env: serverEnv(),
    stderr: 'pipe',
  })
  const stderr = []
  transport.stderr?.on('data', chunk => stderr.push(String(chunk)))
  const client = new Client({ name: 'browser-use-mcp-attach-e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport, { timeout: 120_000 })
  return { client, transport, endpoint, stderr: () => stderr.join('') }
}

/** The text content of one tool result, and its images. */
function content(result) {
  const texts = []
  const images = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') texts.push(block.text)
    if (block.type === 'image') images.push(block)
  }
  return { text: texts.join('\n'), images, isError: result.isError === true }
}

/** Call one tool and return its rendered content, failing the test on a transport error. */
async function call(client, name, args = {}, timeout = 120_000) {
  return content(await client.callTool({ name, arguments: args }, undefined, { timeout }))
}

/** The observation number a page/act result carries. */
function observationOf(text) {
  const matches = [...text.matchAll(/Observation (\d+)\./gu)]
  assert.ok(matches.length > 0, `no observation number in:\n${text}`)
  return Number(matches.at(-1)[1])
}

/** The element line whose description matches, as its index and full line. */
function elementLine(text, pattern) {
  const line = text.split('\n').find(candidate => /^\[\d+\]/u.test(candidate) && pattern.test(candidate))
  assert.ok(line, `no element matching ${pattern} in:\n${text}`)
  return { index: Number(line.match(/^\[(\d+)\]/u)[1]), line }
}

/** The attachment lock file one DevTools endpoint claims under the state root. */
function attachLockPath(endpoint) {
  return join(STATE_ROOT, 'attachments', `${createHash('sha256').update(endpoint).digest('hex').slice(0, 16)}.lock`)
}

/** Install the engine once into the test state root, reusing it on later runs. */
function ensureEngine() {
  execFileSync(process.execPath, [BIN, 'install'], {
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
  })
}

async function main() {
  // A crashed earlier run may have left a browser profile here; this test needs a known start.
  rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
  ensureEngine()

  const chromeDir = mkdtempSync(join(tmpdir(), 'browser-use-mcp-attach-chrome-'))
  const userDataDir = join(chromeDir, 'profile')
  const port = await freePort()
  let launched
  let first
  let second
  try {
    launched = await launchChrome(port, userDataDir)
    const versionAnswer = await version(port)
    assert.ok(versionAnswer?.webSocketDebuggerUrl, 'the launched Chrome publishes a DevTools endpoint')
    passed.push(`a Chrome launched by the test answers on 127.0.0.1:${port} (pid ${launched.child.pid})`)

    first = await startServer(port)

    // 1. The doctor names the attach target and says the browser is reachable — before any page is
    // opened. `Status: ready` in attach mode must mean the browser there is actually there.
    const doctor = await call(first.client, 'browser_doctor', {}, 180_000)
    assert.equal(doctor.isError, false, doctor.text)
    assert.match(doctor.text, new RegExp(`Connection: attach to http://127\\.0\\.0\\.1:${port}`, 'u'), doctor.text)
    assert.match(doctor.text, new RegExp(`Browser\\s+: http://127\\.0\\.0\\.1:${port} answers`, 'u'), doctor.text)
    assert.match(doctor.text, /Status\s*: ready/u, doctor.text)
    assert.match(doctor.text, /Connection: attach/u)
    passed.push('browser_doctor reported the attach target reachable and the server ready')

    // 2. Open the fixture through the attached browser.
    const opened = await call(first.client, 'browser_open', { url: FIXTURE }, 300_000)
    assert.equal(opened.isError, false, opened.text)
    const firstObservation = observationOf(opened.text)
    assert.match(opened.text, /^Page file:\/\/.*fixture\.html — .*Forma · Find a place to slow down$/mu, opened.text)
    assert.match(opened.text, /TYPE_TEXT/u)
    passed.push(`browser_open drove the attached Chrome and read the fixture as observation ${firstObservation}`)

    // 3. The session claimed this DevTools endpoint: the lock names it, and says who holds it.
    const lock = attachLockPath(first.endpoint)
    assert.ok(existsSync(lock), `the attachment lock ${lock} exists while the session holds the browser`)
    const holder = JSON.parse(readFileSync(lock, 'utf8'))
    assert.ok(pidAlive(holder.pid), `the lock records a live cpu pid (${holder.pid})`)
    passed.push('the session claimed the DevTools endpoint with its attachment lock')

    // 4. Re-read, type into the destination, then read the value back from a later observation.
    const reread = await call(first.client, 'browser_page')
    const destination = elementLine(reread.text, /(search|text)box.*destination/iu)
    const typed = await call(first.client, 'browser_act', {
      observation: observationOf(reread.text),
      operation: 'TYPE_TEXT',
      target: String(destination.index),
      text: 'Lisbon',
    })
    assert.match(typed.text, /^Executed TYPE_TEXT on /mu, typed.text)
    const afterTyping = await call(first.client, 'browser_page')
    assert.match(elementLine(afterTyping.text, /(search|text)box.*destination/iu).line, /"Lisbon"/u)
    passed.push('TYPE_TEXT in the attached browser was verified on the page')

    // 5. A screenshot is an MCP image block served from the same CDP connection.
    const shot = await call(first.client, 'browser_screenshot')
    assert.match(shot.text, new RegExp(`^Viewport \\d+x\\d+ of file://`, 'u'))
    assert.equal(shot.images.length, 1)
    assert.equal(shot.images[0].mimeType, 'image/jpeg')
    assert.ok(shot.images[0].data.length > 10_000, 'a real JPEG is more than a few bytes')
    passed.push(`browser_screenshot returned a ${shot.text.match(/Viewport (\d+x\d+)/u)[1]} JPEG`)

    // 6. browser_close closes this session's tab, never the browser it attached to.
    const closed = await call(first.client, 'browser_close')
    assert.match(closed.text, /tab and its daemon are stopped/u)
    assert.match(closed.text, /attached to stays open/u)
    assert.ok(pidAlive(launched.child.pid), 'the attached Chrome process is still running after browser_close')
    assert.ok(await version(port), 'the attached Chrome still answers /json/version after browser_close')
    const noPage = await call(first.client, 'browser_page')
    assert.match(noPage.text, /^Refused: Open a page first\./u)
    passed.push('browser_close closed the tab while the attached Chrome kept running')

    // 7. The session can open another page in the same attached browser.
    const reopened = await call(first.client, 'browser_open', { url: FIXTURE }, 120_000)
    assert.equal(reopened.isError, false, reopened.text)
    assert.ok(observationOf(reopened.text) > firstObservation, 'a reopened page keeps counting observations')
    passed.push('browser_open reused the attached browser for another page')

    // 8. A second server on the same DevTools endpoint is refused, naming the mode that fixes it.
    second = await startServer(port)
    const busy = await call(second.client, 'browser_open', { url: FIXTURE })
    assert.equal(busy.isError, true, 'a second driver on one DevTools endpoint is a failed call')
    assert.match(busy.text, /already attached by another live session or browser-use-mcp process/u, busy.text)
    assert.match(busy.text, /--mode launch/u, busy.text)
    const secondPid = second.transport.pid
    await second.client.close()
    if (secondPid !== null) assert.ok(await waitGone(secondPid), 'the refused server exited')
    second = undefined
    passed.push('a second server on the same DevTools endpoint was refused with a fix')

    // 9. Closing the last server leaves the attached browser alone: this is the whole point of
    // attach mode. The attachment lock is released, so the endpoint can be claimed again.
    const firstPid = first.transport.pid
    await first.client.close()
    if (firstPid !== null) assert.ok(await waitGone(firstPid), 'the attaching server exited')
    first = undefined
    assert.ok(!existsSync(lock), `the attachment lock ${lock} was released by the shut-down server`)
    assert.ok(pidAlive(launched.child.pid), 'the attached Chrome process survived the server shutdown')
    assert.ok(await version(port), 'the attached Chrome still answers /json/version after the server exited')
    passed.push('shutting the server down released its claim and left the attached Chrome running')

    // A later server may attach again: the refusal was ownership, not a permanent claim.
    const later = await startServer(port)
    try {
      const laterOpened = await call(later.client, 'browser_open', { url: FIXTURE }, 120_000)
      assert.equal(laterOpened.isError, false, laterOpened.text)
    } finally {
      const laterPid = later.transport.pid
      await later.client.close()
      if (laterPid !== null) assert.ok(await waitGone(laterPid), 'the later server exited')
    }
    passed.push('the released endpoint could be attached by a later server')

    // 12. The default sharing is `shared`: two servers may drive the attached browser at once, each
    // with its own daemon and its own tab, and neither takes the exclusive lock file.
    const sharedA = await startServer(port, { sharing: null })
    const sharedB = await startServer(port, { sharing: null })
    try {
      const openedA = await call(sharedA.client, 'browser_open', { url: FIXTURE }, 120_000)
      const openedB = await call(sharedB.client, 'browser_open', { url: FIXTURE }, 120_000)
      assert.equal(openedA.isError, false, openedA.text)
      assert.equal(openedB.isError, false, openedB.text)
      assert.ok(observationOf(openedA.text) >= 1 && observationOf(openedB.text) >= 1)
      assert.ok(!existsSync(attachLockPath(`http://127.0.0.1:${port}`)), 'shared attach takes no exclusive lock')
      passed.push('the default attach sharing let two servers drive the attached browser at once')
    } finally {
      for (const server of [sharedA, sharedB]) {
        const pid = server.transport.pid
        await server.client.close().catch(() => {})
        if (pid !== null) await waitGone(pid)
      }
    }
  } finally {
    if (first !== undefined) {
      const pid = first.transport.pid
      await first.client.close().catch(() => {})
      if (pid !== null) await waitGone(pid)
    }
    if (second !== undefined) {
      const pid = second.transport.pid
      await second.client.close().catch(() => {})
      if (pid !== null) await waitGone(pid)
    }
    await stopChrome(launched)
    rmSync(chromeDir, { recursive: true, force: true })
    rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
    // The attachment lock is the server's own; a left one would refuse the next run. Only this
    // test's endpoint lock is removed, and only if a crash got here after the server died.
    if (launched !== undefined) {
      try {
        const lock = attachLockPath(`http://127.0.0.1:${port}`)
        const holder = JSON.parse(readFileSync(lock, 'utf8'))
        if (!pidAlive(holder.pid)) rmSync(lock, { force: true })
      } catch {
        // No lock to remove.
      }
    }
  }

  console.log(passed.map((line, index) => `${index + 1}. ${line}`).join('\n'))
  console.log(`\nPASS: ${passed.length} attach-mode end-to-end checks; a Chrome the test launched itself, no model calls`)
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
})
