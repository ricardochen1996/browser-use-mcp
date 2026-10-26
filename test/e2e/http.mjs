/**
 * End-to-end: several MCP clients on one Streamable HTTP endpoint, each with its own browser.
 *
 * What this proves that stdio cannot: one long-running server serves several agents, they never share
 * a page, closing one session leaves the others working, an idle session's browser is closed and its
 * profile removed, and the server exits cleanly on SIGTERM. No model calls; every outcome is read
 * back from an observation.
 *
 * Run with: node test/e2e/http.mjs
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(ROOT, 'bin', 'browser-use-mcp.mjs')
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'fixture.html')).href
const STATE_ROOT = process.env.BROWSER_USE_MCP_TEST_HOME || join(tmpdir(), 'browser-use-mcp-e2e-home')
const PROFILE = 'e2e-http'
const passed = []

/** A progress line on stderr, so a hang names the step it hung in. */
function step(message) {
  process.stderr.write(`[http-e2e ${new Date().toISOString().slice(11, 19)}] ${message}\n`)
}

/** The environment the HTTP server child starts with: test state root, headless, no model keys. */
function serverEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(TYPESAFE_|TEXT_MODEL_|JEV_)/u.test(name)) delete env[name]
  }
  return {
    ...env,
    BROWSER_USE_MCP_HOME: STATE_ROOT,
    BROWSER_USE_MCP_HEADLESS: '1',
    BROWSER_USE_MCP_PROFILE: PROFILE,
    BROWSER_USE_MCP_LOG_LEVEL: 'info',
    ...extra,
  }
}

/** One free TCP port, so parallel test runs do not collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Install the engine once into the shared test state root. */
function ensureEngine() {
  execFileSync(process.execPath, [BIN, 'install'], {
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
  })
}

/** Spawn the HTTP server and wait until it announces its endpoint. */
async function startServer(env = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [BIN, '--transport', 'http', '--host', '127.0.0.1', '--port', String(port)], {
    env: serverEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = `http://127.0.0.1:${port}/mcp`
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the HTTP server exited early:\n${stderr}`)
    if (stderr.includes('serving MCP over Streamable HTTP')) return { child, url, stderr: () => stderr }
    try {
      const response = await fetch(url, { method: 'GET' })
      if (response.status === 400) return { child, url, stderr: () => stderr }
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`the HTTP server never started:\n${stderr}`)
}

/** An MCP client over Streamable HTTP; one client is one MCP session and one browser. */
async function connect(url) {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'browser-use-mcp-http-e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport, { timeout: 120_000 })
  return { client, transport }
}

/** The text content of one tool result and its images. */
function content(result) {
  const texts = []
  const images = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') texts.push(block.text)
    if (block.type === 'image') images.push(block)
  }
  return { text: texts.join('\n'), images, isError: result.isError === true }
}

async function call(client, name, args = {}, timeout = 120_000) {
  return content(await client.callTool({ name, arguments: args }, undefined, { timeout }))
}

function observationOf(text) {
  const matches = [...text.matchAll(/Observation (\d+)\./gu)]
  assert.ok(matches.length > 0, `no observation number in:\n${text}`)
  return Number(matches.at(-1)[1])
}

function elementLine(text, pattern) {
  const line = text.split('\n').find(candidate => /^\[\d+\]/u.test(candidate) && pattern.test(candidate))
  assert.ok(line, `no element matching ${pattern} in:\n${text}`)
  return { index: Number(line.match(/^\[(\d+)\]/u)[1]), line }
}

/** The profile directories this test's server created under the state root. */
function profileDirs() {
  const root = join(STATE_ROOT, 'profiles')
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => name.startsWith(PROFILE))
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for ${description}`)
}

/** Stop one server child and prove it exited. */
async function stopServer(server, label) {
  server.child.kill('SIGTERM')
  const waitExit = timeout => new Promise(resolve => {
    if (server.child.exitCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeout)
    server.child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  let exited = await waitExit(20_000)
  if (!exited) {
    // Leave nothing behind even on the failure path, so a broken shutdown is reported, not hung.
    server.child.kill('SIGKILL')
    exited = await waitExit(5_000)
  }
  assert.ok(exited, `${label}: the server did not exit on SIGTERM:\n${server.stderr().slice(-3000)}`)
}

async function main() {
  for (const directory of profileDirs()) rmSync(join(STATE_ROOT, 'profiles', directory), { recursive: true, force: true })
  ensureEngine()

  // ---- One server, two agents, long idle timeout so the isolation checks are not racing a sweep.
  step('starting the shared server')
  const shared = await startServer({ BROWSER_USE_MCP_HTTP_IDLE_MS: '600000' })
  step('shared server started')
  try {
    const notFound = await fetch(new URL('/other', shared.url))
    assert.equal(notFound.status, 404)
    const bareGet = await fetch(shared.url)
    assert.equal(bareGet.status, 400)
    assert.match(await bareGet.text(), /initialize/u)
    passed.push('the endpoint routes by path and answers a bare request with guidance')

    step('connecting two clients')
    const a = await connect(shared.url)
    const b = await connect(shared.url)
    step('two clients connected')
    try {
      const tools = (await a.client.listTools()).tools.map(tool => tool.name)
      assert.equal(tools.length, 9, tools.join(', '))
      assert.equal(new Set(tools).size, tools.length)

      step('opening a page in both sessions')
      const openedA = await call(a.client, 'browser_open', { url: FIXTURE }, 300_000)
      step('session A opened; session B opening')
      const openedB = await call(b.client, 'browser_open', { url: FIXTURE }, 300_000)
      step('both sessions opened')
      assert.equal(observationOf(openedA.text), 1)
      assert.equal(observationOf(openedB.text), 1, 'each MCP session numbers its own observations')
      passed.push('two HTTP clients each opened a page as observation 1')

      // Isolation: acting in session A must not change what session B sees.
      const rereadA = await call(a.client, 'browser_page')
      const destination = elementLine(rereadA.text, /(search|text)box.*destination/iu)
      await call(a.client, 'browser_act', {
        observation: observationOf(rereadA.text),
        operation: 'TYPE_TEXT',
        target: String(destination.index),
        text: 'Lisbon',
      })
      const afterA = await call(a.client, 'browser_page')
      assert.match(elementLine(afterA.text, /(search|text)box.*destination/iu).line, /"Lisbon"/u)
      const bSees = await call(b.client, 'browser_page')
      assert.doesNotMatch(elementLine(bSees.text, /(search|text)box.*destination/iu).line, /"Lisbon"/u)
      assert.equal(observationOf(bSees.text), 2, 'session B advanced only its own observation count')
      passed.push('typing in session A left session B on its own untouched page')

      const shot = await call(a.client, 'browser_screenshot')
      assert.equal(shot.images.length, 1)
      assert.equal(shot.images[0].mimeType, 'image/jpeg')

      // Closing one session's tab leaves the other one working.
      const closed = await call(a.client, 'browser_close')
      assert.match(closed.text, /tab is closed/u)
      const bStillWorks = await call(b.client, 'browser_page')
      assert.match(bStillWorks.text, /^Page file:\/\//mu)
      passed.push('closing session A’s tab left session B working')

      // A client that terminates its session gets its browser and profile cleaned up immediately.
      step('terminating session B')
      await b.transport.terminateSession()
      step('session B terminated; waiting for its profile cleanup')
      await waitFor(() => profileDirs().length === 1, 30_000, 'the terminated session to be cleaned up')
      passed.push('terminateSession closed session B and removed its profile')
    } finally {
      await a.client.close().catch(() => {})
      await b.client.close().catch(() => {})
    }
  } finally {
    step('stopping the shared server')
    await stopServer(shared, 'shared')
    step('shared server stopped')
  }
  // SIGTERM released the remaining session (A never terminated itself) and every profile it owned.
  await waitFor(() => profileDirs().length === 0, 10_000, 'the remaining profile to be removed on SIGTERM')
  passed.push('SIGTERM shut the shared server down and left no browser profiles behind')

  // ---- A second server with a short idle timeout: silence must clean the browser up.
  step('starting the idle-timeout server')
  const idling = await startServer({ BROWSER_USE_MCP_HTTP_IDLE_MS: '3000' })
  step('idle-timeout server started')
  try {
    const c = await connect(idling.url)
    const opened = await call(c.client, 'browser_open', { url: FIXTURE }, 300_000)
    assert.match(opened.text, /^Page file:\/\//mu)
    assert.equal(profileDirs().length, 1)
    step('waiting for the idle session to be cleaned up')
    await waitFor(() => profileDirs().length === 0, 20_000, 'the idle session to be cleaned up')
    step('idle session cleaned up')
    let failed = false
    try {
      await call(c.client, 'browser_page')
    } catch {
      failed = true // the session is gone: the client cannot post to it any more
    }
    assert.ok(failed, 'the expired session refuses further calls')
    await c.client.close().catch(() => {})
    const fresh = await connect(idling.url)
    const reopened = await call(fresh.client, 'browser_open', { url: FIXTURE }, 300_000)
    assert.match(reopened.text, /^Page file:\/\//mu)
    await fresh.transport.terminateSession()
    passed.push('an idle session’s browser and profile were removed, and a new session still works')
  } finally {
    step('stopping the idle-timeout server')
    await stopServer(idling, 'idling')
    step('idle-timeout server stopped')
  }
  await waitFor(() => profileDirs().length === 0, 10_000, 'the last profile to be removed')

  console.log(passed.map((line, index) => `${index + 1}. ${line}`).join('\n'))
  console.log(`\nPASS: ${passed.length} HTTP end-to-end checks; real headless browsers on one endpoint, no model calls`)
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
})
