/**
 * The protocol itself, with no MCP SDK on this side of the wire.
 *
 * Every other e2e suite speaks through the official SDK client. This one writes JSON-RPC frames by
 * hand, which is the check that matters for "any agent": a host that speaks the Model Context
 * Protocol — not necessarily the SDK this package was tested with — still finds the server, lists
 * the same tools, and drives the browser. A real headless Chrome, no model calls.
 *
 * Run with: node test/e2e/protocol.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(ROOT, 'bin', 'browser-use-mcp.mjs')
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'fixture.html')).href
const STATE_ROOT = process.env.BROWSER_USE_MCP_TEST_HOME || join(tmpdir(), 'browser-use-mcp-e2e-home')
const PROFILE = 'e2e-protocol'
const passed = []

/** The environment: a test state root, headless, and no model keys. */
function serverEnv() {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(TYPESAFE_|TEXT_MODEL_|JEV_)/u.test(name)) delete env[name]
  }
  return {
    ...env,
    BROWSER_USE_MCP_HOME: STATE_ROOT,
    BROWSER_USE_MCP_MODE: 'launch',
    BROWSER_USE_MCP_HEADLESS: '1',
    BROWSER_USE_MCP_PROFILE: PROFILE,
    BROWSER_USE_MCP_LOG_LEVEL: 'error',
  }
}

/** One JSON-RPC peer over a child's stdin/stdout: the whole protocol surface this test uses. */
class Peer {
  constructor(child) {
    this.child = child
    this.sequence = 0
    this.pending = new Map()
    this.notifications = []
    this.closed = new Promise(resolve => child.once('exit', code => resolve(code)))
    createInterface({ input: child.stdout }).on('line', line => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id === undefined) {
        this.notifications.push(message)
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`))
      else entry.resolve(message.result)
    })
  }

  /** Write one JSON-RPC object. */
  write(message) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  /** Send a request and settle on its answer or a protocol error. */
  request(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  /** Send a notification (no answer expected). */
  notify(method, params = {}) {
    this.write({ method, params })
  }
}

/** The text content of one tools/call result. */
function content(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function observationOf(text) {
  const matches = [...text.matchAll(/Observation (\d+)\./gu)]
  assert.ok(matches.length > 0, `no observation number in:\n${text}`)
  return Number(matches.at(-1)[1])
}

function ensureEngine() {
  execFileSync(process.execPath, [BIN, 'install'], {
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
  })
}

async function main() {
  rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
  ensureEngine()
  const child = spawn(process.execPath, [BIN], { env: serverEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const peer = new Peer(child)
  try {
    // 1. initialize: the handshake every MCP host starts with.
    const initialized = await peer.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw-jsonrpc-e2e', version: '0.0.0' },
    })
    assert.equal(initialized.serverInfo.name, 'browser-use-mcp', JSON.stringify(initialized.serverInfo))
    assert.equal(typeof initialized.serverInfo.version, 'string')
    assert.ok(initialized.capabilities.tools !== undefined, 'the server offers tools')
    assert.equal(typeof initialized.instructions, 'string')
    assert.match(initialized.instructions, /indexed action space/u)
    peer.notify('notifications/initialized')
    passed.push(`a hand-written initialize found ${initialized.serverInfo.name} ${initialized.serverInfo.version} with instructions`)

    // 2. tools/list over the raw protocol.
    const listed = await peer.request('tools/list')
    const names = listed.tools.map(tool => tool.name)
    assert.equal(names.length, 9, names.join(', '))
    assert.deepEqual([...names].sort(), [
      'browser_act', 'browser_close', 'browser_console', 'browser_doctor', 'browser_eval',
      'browser_goal', 'browser_open', 'browser_page', 'browser_screenshot',
    ])
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, 'object')
      assert.ok((tool.description ?? '').length > 40)
    }
    passed.push('tools/list returned the nine action-space tools, each with a schema and description')

    // 3. tools/call: open, read, and a refusal — all with plain JSON-RPC.
    const opened = await peer.request('tools/call', { name: 'browser_open', arguments: { url: FIXTURE } })
    assert.notEqual(opened.isError, true, content(opened))
    const first = observationOf(content(opened))
    assert.match(content(opened), /^Page file:\/\//mu)
    const reread = await peer.request('tools/call', { name: 'browser_page', arguments: {} })
    const second = observationOf(content(reread))
    assert.ok(second > first)
    const refused = await peer.request('tools/call', {
      name: 'browser_act',
      arguments: { observation: 999_999, operation: 'WAIT' },
    })
    assert.notEqual(refused.isError, true, 'a refusal is a successful tool result')
    assert.match(content(refused), /^Refused: observation 999999 is not one this session produced/u)
    passed.push(`tools/call opened the fixture as observation ${first} and refused a foreign observation over raw JSON-RPC`)

    // 4. An unknown tool is rejected and visibly failed, never silently "successful": hosts differ on
    // whether that is a JSON-RPC error or an isError tool result, so both count.
    let unknownRejected = false
    try {
      const result = await peer.request('tools/call', { name: 'browser_nope', arguments: {} })
      unknownRejected = result?.isError === true && /not found|unknown tool/iu.test(content(result))
    } catch {
      unknownRejected = true
    }
    assert.ok(unknownRejected, 'an unknown tool must be rejected')
    passed.push('an unknown tool was rejected instead of answered')

    // 5. Closing stdin ends the session; the server must not outlive its client.
    child.stdin.end()
    const code = await Promise.race([
      peer.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('the server did not exit after stdin closed')), 30_000)),
    ])
    assert.equal(code, 0, `the server exited with ${code}:\n${stderr.slice(-2000)}`)
    passed.push('closing stdin made the server exit cleanly')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
  }

  console.log(passed.map((line, index) => `${index + 1}. ${line}`).join('\n'))
  console.log(`\nPASS: ${passed.length} raw JSON-RPC checks; no MCP SDK on the client side, no model calls`)
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
})
