/**
 * End-to-end: two stdio servers on the same profile must never share one Browser Harness daemon.
 *
 * The reported bug: every stdio server configured with the default profile named its daemon
 * `browser-use-mcp-<profile>`, so two servers started one daemon, drove it over one connection, and
 * stopping either one stopped the daemon under the other — whose next call then failed with the raw
 * Python `FileNotFoundError: [Errno 2] No such file or directory`, forever. The host-side fix names
 * every daemon after the server process that owns it (`browser-use-mcp-<profile>-p<pid>`, plus a
 * `-g<N>` generation suffix), so two server processes can never own the same daemon.
 *
 * This test launches its own headless Chrome (nothing of the user's is touched), starts two servers
 * attached to it on the same profile, and checks the observable consequences rather than trusting a
 * tool's own claim: each server has its own daemon name and its own tab on the page, and after the
 * first server is stopped the second still serves `browser_page` and a guarded `browser_act` CLICK,
 * verified from the page itself.
 *
 * Daemon state is read from a runtime directory this test owns (`<test home>/runtime`, passed to the
 * servers as `BH_RUNTIME_DIR`), so it works where `ps` is unavailable and never writes under $HOME.
 *
 * Run with: node test/e2e/daemon-isolation.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
const PROFILE = 'e2e-daemon-isolation'
/** The test's own Browser Harness runtime directory: daemon names are read from here as evidence. */
const RUNTIME_DIR = join(STATE_ROOT, 'runtime')
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const passed = []

/** The environment every server child starts with: a test state root, no model keys, no $HOME writes. */
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
    // Browser Harness would otherwise keep its daemon pid/socket files under $HOME. Naming a
    // runtime directory makes this test's daemons observable here and leaves no user state behind.
    BH_RUNTIME_DIR: RUNTIME_DIR,
    BH_TMP_DIR: join(STATE_ROOT, 'tmp'),
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
  throw new Error('no Chrome or Chromium executable found for the daemon-isolation test')
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
function getLoopback(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port, path, agent: false }, response => {
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
    return await getLoopback(port, '/json/version')
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
    // Sandboxes and containers cannot nest Chrome's own sandbox; the flag is harmless elsewhere.
    '--no-sandbox',
    '--disable-gpu',
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
 * One server child plus the MCP client on it, attached to the DevTools endpoint.
 * @param {number} port - the Chrome DevTools port.
 */
async function startServer(port) {
  const endpoint = `http://127.0.0.1:${port}`
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'serve', '--mode', 'attach', '--cdp-endpoint', endpoint, '--log-level', 'info'],
    env: serverEnv(),
    stderr: 'pipe',
  })
  const stderr = []
  transport.stderr?.on('data', chunk => stderr.push(String(chunk)))
  const client = new Client({ name: 'browser-use-mcp-daemon-isolation-e2e', version: '0.0.0' }, { capabilities: {} })
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

/**
 * The daemon files this test's runtime directory holds: `{ name, pid?, alive }`.
 *
 * Browser Harness writes `<stem>.pid`/`<stem>.sock` here (the host declares the directory shared, so
 * the stem carries the daemon name). This is the evidence the test asserts on; `ps` is not used
 * because it is unavailable in some sandboxes and is not needed for a pid-file check.
 */
function daemons() {
  if (!existsSync(RUNTIME_DIR)) return []
  return readdirSync(RUNTIME_DIR)
    .filter(name => /^bu-.*\.pid$/u.test(name))
    .sort()
    .map(name => {
      let pid
      try { pid = Number(readFileSync(join(RUNTIME_DIR, name), 'utf8').trim()) } catch { pid = undefined }
      return {
        file: name,
        name: name.slice('bu-'.length, -'.pid'.length),
        pid,
        alive: Number.isInteger(pid) && pid > 0 && pidAlive(pid),
      }
    })
}

/**
 * The daemon name one server process owns, found by the process token in its name.
 *
 * A name is `browser-use-mcp-<stem>-p<pid>` (plus a `-g<N>` generation suffix), where `<stem>` is the
 * profile or, when the socket path would be too long for the platform's runtime directory, a short
 * digest of it. Which of the two a given checkout gets depends on `tmpdir()`, so the test keys on the
 * pid token every name carries instead of rebuilding the production naming rule here.
 */
function daemonNameFor(serverPid) {
  const owned = daemons().filter(daemon => new RegExp(`-p${serverPid}(-g\\d+)?$`, 'u').test(daemon.name))
  assert.equal(owned.length, 1,
    `expected exactly one daemon owned by server pid ${serverPid}, found: ${daemons().map(daemon => daemon.name).join(', ') || '(none)'}`)
  return owned[0].name
}

/** Remove daemon files a crashed earlier run left in this test's runtime directory. */
function reapRuntimeDir() {
  for (const daemon of daemons()) {
    if (daemon.alive) {
      try { process.kill(daemon.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  rmSync(RUNTIME_DIR, { recursive: true, force: true })
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
  // A crashed earlier run may have left daemons or a browser profile; this test needs a known start.
  reapRuntimeDir()
  rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
  mkdirSync(RUNTIME_DIR, { recursive: true })
  ensureEngine()

  const chromeDir = mkdtempSync(join(tmpdir(), 'browser-use-mcp-daemon-isolation-chrome-'))
  const userDataDir = join(chromeDir, 'profile')
  const port = await freePort()
  let launched
  let first
  let second
  try {
    launched = await launchChrome(port, userDataDir)
    passed.push(`a Chrome launched by the test answers on 127.0.0.1:${port} (pid ${launched.child.pid})`)

    // Both servers use the same profile and the same DevTools endpoint: exactly the reported setup.
    first = await startServer(port)
    const firstPid = first.transport.pid
    assert.ok(Number.isInteger(firstPid), 'the first server child has a pid')
    const openedA = await call(first.client, 'browser_open', { url: `${FIXTURE}#daemon-a` }, 300_000)
    assert.equal(openedA.isError, false, openedA.text)

    second = await startServer(port)
    const secondPid = second.transport.pid
    assert.ok(Number.isInteger(secondPid), 'the second server child has a pid')
    assert.notEqual(firstPid, secondPid, 'the two servers are two processes')
    const openedB = await call(second.client, 'browser_open', { url: `${FIXTURE}#daemon-b` }, 300_000)
    assert.equal(openedB.isError, false, openedB.text)
    const secondObservation = observationOf(openedB.text)
    passed.push(`two stdio servers on profile "${PROFILE}" each opened the fixture`)

    // 1. Each server process owns its own daemon, named after itself.
    const running = daemons()
    const names = running.map(daemon => daemon.name)
    assert.equal(running.length, 2, `expected two daemons, found: ${names.join(', ') || '(none)'}`)
    const firstDaemon = daemonNameFor(firstPid)
    const secondDaemon = daemonNameFor(secondPid)
    assert.notEqual(firstDaemon, secondDaemon, 'the two servers must not share one daemon')
    for (const daemon of running) assert.ok(daemon.alive, `daemon ${daemon.name} (pid ${daemon.pid}) is running`)
    passed.push(`each server has its own daemon: ${firstDaemon}, ${secondDaemon}`)

    // 2. Each server drives its own tab: the page each one reads carries the fragment only it opened.
    const hrefA = await call(first.client, 'browser_eval', { expression: 'location.href' })
    const hrefB = await call(second.client, 'browser_eval', { expression: 'location.href' })
    assert.match(hrefA.text, /#daemon-a/u, hrefA.text)
    assert.match(hrefB.text, /#daemon-b/u, hrefB.text)
    assert.doesNotMatch(hrefA.text, /#daemon-b/u, 'the first server was moved to the second server\u2019s tab')
    passed.push('each server drives its own tab (different fragments, read from the page)')

    // 3. Stop the first server the way an MCP client does. Its own daemon goes with it; the second
    // server's daemon, and the tab it drives, must not be touched.
    const firstDaemonPid = running.find(daemon => daemon.name === firstDaemon)?.pid
    const secondDaemonPid = running.find(daemon => daemon.name === secondDaemon)?.pid
    await first.client.close()
    first = undefined
    assert.ok(await waitGone(firstPid, 30_000), 'the first server process exited when its client closed')
    if (Number.isInteger(firstDaemonPid)) assert.ok(await waitGone(firstDaemonPid, 30_000), 'the first server\u2019s daemon stopped with it')
    assert.ok(Number.isInteger(secondDaemonPid) && pidAlive(secondDaemonPid), 'the second server\u2019s daemon is still running')
    assert.ok(!existsSync(join(RUNTIME_DIR, `bu-${firstDaemon}.pid`)), 'the first server\u2019s daemon files are gone')
    assert.ok(existsSync(join(RUNTIME_DIR, `bu-${secondDaemon}.pid`)), 'the second server\u2019s daemon files remain')
    passed.push('stopping the first server stopped its own daemon only')

    // 4. The surviving server still serves a full observation of its own page.
    const reread = await call(second.client, 'browser_page')
    assert.equal(reread.isError, false, reread.text)
    assert.match(reread.text, /#daemon-b/u, reread.text)
    assert.ok(observationOf(reread.text) > secondObservation, 'the surviving server keeps counting observations')
    passed.push(`the surviving server served browser_page as observation ${observationOf(reread.text)}`)

    // 5. And a guarded CLICK still executes, verified on the page afterwards — not from the act reply.
    const reading = elementLine(reread.text, /link .*Reading room/iu)
    const clicked = await call(second.client, 'browser_act', {
      observation: observationOf(reread.text),
      operation: 'CLICK',
      target: String(reading.index),
    })
    assert.match(clicked.text, /^Executed CLICK on /mu, clicked.text)
    const title = await call(second.client, 'browser_eval', { expression: 'document.title' })
    assert.match(title.text, /Reading room/u, title.text)
    passed.push('the surviving server executed a guarded CLICK, verified by the page title')

    // Nothing from the stopped server is left behind, and the surviving one still owns its daemon.
    const remaining = daemons()
    assert.deepEqual(remaining.map(daemon => daemon.name), [secondDaemon],
      `daemons left: ${remaining.map(daemon => `${daemon.name} (${daemon.pid})`).join(', ')}`)
    passed.push('no daemon of the stopped server outlived it')
  } finally {
    for (const [label, server] of [['first', first], ['second', second]]) {
      if (!server) continue
      const pid = server.transport.pid
      try { await server.client.close() } catch { /* already gone */ }
      if (pid !== null) {
        if (!await waitGone(pid, 10_000)) throw new Error(`the ${label} server did not exit`)
      }
    }
    await stopChrome(launched)
    rmSync(chromeDir, { recursive: true, force: true })
    rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
    // Every daemon in this test's runtime directory belongs to this test; a crashed run may have left
    // one. The runtime directory itself is the test's own, so removing it is safe.
    for (const daemon of daemons()) {
      if (daemon.alive) {
        try { process.kill(daemon.pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
    rmSync(RUNTIME_DIR, { recursive: true, force: true })
  }

  console.log(passed.map((line, index) => `${index + 1}. ${line}`).join('\n'))
  console.log(`\nPASS: ${passed.length} daemon-isolation end-to-end checks; a Chrome the test launched itself, no model calls`)
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
})
