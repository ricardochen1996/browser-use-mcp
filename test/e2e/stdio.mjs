/**
 * End-to-end: a real MCP client drives a real headless Chrome through this server, over stdio.
 *
 * No model calls: the fixture page is static and every outcome is read back from a later observation,
 * not from the action's own return value. The engine environment lives under a test state root that
 * is reused between runs, so the first run installs it (~a minute) and later runs start at once.
 *
 * Run with: node test/e2e/stdio.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(ROOT, 'bin', 'browser-use-mcp.mjs')
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'fixture.html')).href
const STATE_ROOT = process.env.BROWSER_USE_MCP_TEST_HOME || join(tmpdir(), 'browser-use-mcp-e2e-home')
const PROFILE = 'e2e-stdio'
const passed = []

/** The environment every server child starts with: a test state root, headless, no model keys. */
function serverEnv(extra = {}) {
  const env = { ...process.env }
  // The test must not spend the shell's model quota or inherit a Jev key.
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

/** One server child plus the MCP client on it. */
async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: serverEnv(extraEnv),
    stderr: 'pipe',
  })
  const stderr = []
  transport.stderr?.on('data', chunk => stderr.push(String(chunk)))
  const client = new Client({ name: 'browser-use-mcp-e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport, { timeout: 120_000 })
  return { client, transport, stderr }
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
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout })
  return content(result)
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

/** The target string of one dropdown option under an element line. */
function optionLine(text, labelPattern) {
  const line = text.split('\n').find(candidate => /^\s+\S+ → /u.test(candidate) && labelPattern.test(candidate))
  assert.ok(line, `no option matching ${labelPattern}`)
  return line.trim().split(' → ')[0]
}

/** Wait until a pid is gone, so a test can prove the server process ended. */
async function waitGone(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** Where Browser Harness keeps daemon pid/socket files, matching lib/sidecar.js's resolution. */
function daemonRuntimeDir() {
  const env = serverEnv()
  const caller = env.BH_RUNTIME_DIR || env.BH_TMP_DIR
  if (caller) return caller.replace(/^~(?=$|\/)/u, homedir())
  const home = env.BH_HOME || env.BROWSER_HARNESS_HOME
    || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'browser-harness') : join(homedir(), '.config', 'browser-harness'))
  return join(home, 'runtime')
}

/** The Python children of one server process: the sidecars it owns. */
function sidecarChildren(serverPid) {
  const listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return listing.split('\n')
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/u))
    .filter(match => match !== null)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
    .filter(entry => entry.ppid === serverPid && entry.command.includes('sidecar/bridge.py'))
}

/** Wait until a pid is really gone. */
async function waitDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
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
  // A crashed earlier run may have left a browser on this profile; the fixture needs a known start.
  rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })
  if (!existsSync(join(STATE_ROOT, 'env'))) {
    process.stderr.write(`installing the browser engine into ${join(STATE_ROOT, 'env')} (first run only)...\n`)
  }
  ensureEngine()

  const first = await startServer()
  try {
    // 1. Discovery: the tool surface and its descriptions.
    const listed = await first.client.listTools()
    const names = listed.tools.map(tool => tool.name)
    for (const expected of [
      'browser_open', 'browser_page', 'browser_act', 'browser_eval', 'browser_screenshot',
      'browser_console', 'browser_goal', 'browser_close', 'browser_doctor',
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}: ${names.join(', ')}`)
    }
    for (const tool of listed.tools) assert.ok((tool.description ?? '').length > 40, `${tool.name} has no useful description`)
    const instructions = first.client.getInstructions() ?? ''
    assert.match(instructions, /indexed action space/u)
    assert.match(instructions, /One connection, one driver/u)
    passed.push(`the server offers ${names.length} tools with instructions`)

    // A close with nothing open is a refusal, not a browser launch.
    const idleClose = await call(first.client, 'browser_close')
    assert.equal(idleClose.isError, false)
    assert.match(idleClose.text, /nothing to close/u)
    passed.push('browser_close with no open page refused instead of starting a browser')

    // 2. Open the fixture and read its action space.
    const opened = await call(first.client, 'browser_open', { url: FIXTURE })
    assert.equal(opened.isError, false, opened.text)
    const firstObservation = observationOf(opened.text)
    assert.match(opened.text, /^Page file:\/\/.*fixture\.html — .*Forma · Find a place to slow down$/mu)
    assert.match(opened.text, /TYPE_TEXT/u)
    assert.match(opened.text, /SELECT/u)
    assert.match(opened.text, /CLICK/u)
    passed.push(`browser_open read the fixture as observation ${firstObservation}`)

    // 3. A re-read is a new observation of the same page.
    const reread = await call(first.client, 'browser_page')
    const secondObservation = observationOf(reread.text)
    assert.ok(secondObservation > firstObservation, 'browser_page produces a new observation number')
    passed.push('browser_page produced a new observation')

    // 4. TYPE_TEXT, verified by the next observation's element value.
    const destination = elementLine(reread.text, /(search|text)box.*destination/iu)
    const typed = await call(first.client, 'browser_act', {
      observation: secondObservation,
      operation: 'TYPE_TEXT',
      target: String(destination.index),
      text: 'Lisbon',
    })
    assert.match(typed.text, /^Executed TYPE_TEXT on /mu)
    let current = observationOf(typed.text)
    const afterTyping = await call(first.client, 'browser_page')
    current = observationOf(afterTyping.text)
    assert.match(elementLine(afterTyping.text, /(search|text)box.*destination/iu).line, /"Lisbon"/u)
    passed.push('TYPE_TEXT entered the destination and the page shows the value')

    // 5. SELECT uses an observed option target.
    const category = elementLine(afterTyping.text, /combobox.*category/iu)
    const design = optionLine(afterTyping.text, /→ Design$/u)
    const selected = await call(first.client, 'browser_act', {
      observation: current,
      operation: 'SELECT',
      target: design,
    })
    assert.match(selected.text, /^Executed SELECT on /mu)
    current = observationOf(selected.text)
    passed.push(`SELECT used the observed option target ${design}`)

    // 6. CLICK the filter submit; the outcome is read from the resulting page text.
    const submit = elementLine(selected.text, /button.*(find|filter|show)/iu)
    const filtered = await call(first.client, 'browser_act', {
      observation: current,
      operation: 'CLICK',
      target: String(submit.index),
    })
    assert.match(filtered.text, /^Executed CLICK on /mu)
    assert.match(filtered.text, /Casa Flora/u, filtered.text.slice(0, 800))
    current = observationOf(filtered.text)
    passed.push('the submitted filters filtered the page to the matching stay')

    // 7. Open the stay and read back both values on the destination page.
    const view = elementLine(filtered.text, /(view|open).*casa flora/iu)
    const openedStay = await call(first.client, 'browser_act', {
      observation: current,
      operation: 'CLICK',
      target: String(view.index),
    })
    assert.match(openedStay.text, /Destination Lisbon/u)
    assert.match(openedStay.text, /Design/u)
    current = observationOf(openedStay.text)
    passed.push('the opened stay reports the typed destination and the chosen category')

    // 8. An old observation is refused, and the refusal carries the fresh table.
    // WAIT is offered on every page, so the operation resolves and the fingerprint check is what
    // refuses — which is the guard under test.
    const stale = await call(first.client, 'browser_act', {
      observation: firstObservation,
      operation: 'WAIT',
    })
    assert.equal(stale.isError, false, 'a stale refusal is a successful tool call')
    assert.match(stale.text, /^Nothing was executed: /u)
    const freshObservation = observationOf(stale.text)
    assert.ok(freshObservation > current, 'the refusal carries a new observation')
    current = freshObservation
    passed.push('an action on a moved page was refused, with the fresh table')

    // 9. Refusals that never reach the browser.
    const unknownOperation = await call(first.client, 'browser_act', { observation: current, operation: 'DRAG', target: '1' })
    assert.match(unknownOperation.text, /^Refused: DRAG is not an operation/u)
    const noText = await call(first.client, 'browser_act', { observation: current, operation: 'TYPE_TEXT', target: String(destination.index) })
    assert.match(noText.text, /^Refused: TYPE_TEXT needs the text/u)
    const foreignObservation = await call(first.client, 'browser_act', { observation: 999_999, operation: 'CLICK', target: '1' })
    assert.match(foreignObservation.text, /^Refused: observation 999999 is not one this session produced/u)
    passed.push('bad operations, missing text and foreign observations refused with guidance')

    // 10. browser_eval: one expression, its value as text, no observation.
    const title = await call(first.client, 'browser_eval', { expression: 'document.title' })
    assert.match(title.text, /Casa Flora · Forma/u)
    assert.match(title.text, /this is not an observation/u)
    const thrown = await call(first.client, 'browser_eval', { expression: '(() => { throw new Error("boom") })()' })
    assert.match(thrown.text, /the expression threw/u)
    passed.push('browser_eval returned a value and reported a thrown expression')

    // 11. Screenshot: an MCP image block plus its size.
    const shot = await call(first.client, 'browser_screenshot')
    assert.match(shot.text, /^Viewport \d+x\d+ of file:\/\//mu)
    assert.equal(shot.images.length, 1)
    assert.equal(shot.images[0].mimeType, 'image/jpeg')
    assert.ok(shot.images[0].data.length > 10_000, 'a real JPEG is more than a few bytes')
    passed.push(`browser_screenshot returned a ${shot.text.match(/Viewport (\d+x\d+)/u)[1]} JPEG`)

    // 12. Console diagnostics are readable and say where from.
    const diagnostics = await call(first.client, 'browser_console')
    assert.match(diagnostics.text, /^Page file:\/\//mu)
    assert.match(diagnostics.text, /Console:/u)
    passed.push('browser_console returned the page diagnostics')

    // 13. The doctor can be called by an agent.
    const doctor = await call(first.client, 'browser_doctor', {}, 180_000)
    assert.match(doctor.text, /Status\s*: ready/u, doctor.text)
    assert.match(doctor.text, /Engine\s*: /u)
    assert.match(doctor.text, /Session\s*: page .*file:\/\//u)
    passed.push('browser_doctor reported the session ready')

    // 14. browser_close closes the tab but keeps the browser for the next open.
    const closed = await call(first.client, 'browser_close')
    assert.match(closed.text, /tab is closed/u)
    const afterClose = await call(first.client, 'browser_page')
    assert.match(afterClose.text, /^Refused: Open a page first\./u)
    const reopened = await call(first.client, 'browser_open', { url: FIXTURE })
    assert.ok(observationOf(reopened.text) > current, 'a reopened session keeps counting observations')
    passed.push('browser_close closed the tab, and browser_open reused the browser')

    // 15. A crashed sidecar is replaced by a new generation, keeps no stale table, and leaks no daemon.
    const daemonPidPath = join(daemonRuntimeDir(), `bu-browser-use-mcp-${PROFILE}.pid`)
    assert.ok(existsSync(daemonPidPath), `the running browser's daemon pid should exist at ${daemonPidPath}`)
    const crashedDaemon = Number(readFileSync(daemonPidPath, 'utf8').trim())
    const [sidecar] = sidecarChildren(first.transport.pid)
    assert.ok(sidecar !== undefined, 'the server has a sidecar child while a page is open')
    process.kill(sidecar.pid, 'SIGKILL')
    assert.ok(await waitDead(sidecar.pid), 'the sidecar was killed')
    const afterCrash = await call(first.client, 'browser_page')
    assert.equal(afterCrash.isError, false, 'a lost session is a refusal, not a failed call')
    assert.match(afterCrash.text, /^Refused: Open a page first\./u)
    assert.doesNotMatch(afterCrash.text, /Targets below are valid only for this observation/u, 'no dead generation table')
    assert.ok(await waitDead(crashedDaemon), 'the crashed generation\u2019s browser-harness daemon was reaped')
    const afterReopen = await call(first.client, 'browser_open', { url: FIXTURE })
    assert.match(afterReopen.text, /not shut down cleanly/u)
    assert.ok(observationOf(afterReopen.text) > current, 'the new generation starts a new observation')
    current = observationOf(afterReopen.text)
    passed.push('a killed sidecar was replaced by a fresh generation, with no stale table and no leaked daemon')

    // 16. A second server on the same profile is refused instead of driving one browser twice.
    const second = await startServer()
    try {
      const busy = await call(second.client, 'browser_open', { url: FIXTURE })
      assert.equal(busy.isError, true, 'a profile collision is a failed call')
      assert.match(busy.text, /already driven by another browser-use-mcp process/u)
      passed.push('a second server on the same profile was refused with a fix')
    } finally {
      const secondPid = second.transport.pid
      await second.client.close()
      if (secondPid !== null) assert.ok(await waitGone(secondPid), 'the refused server exited')
    }

    // 17. The surface switches withdraw tools; the server still starts and lists what is left.
    const minimal = await startServer({ BROWSER_USE_MCP_NO_EVAL: '1', BROWSER_USE_MCP_NO_SCREENSHOTS: '1', BROWSER_USE_MCP_NO_JEV: '1' })
    try {
      const minimalTools = (await minimal.client.listTools()).tools.map(tool => tool.name)
      assert.ok(!minimalTools.includes('browser_eval'))
      assert.ok(!minimalTools.includes('browser_screenshot'))
      assert.ok(!minimalTools.includes('browser_goal'))
      for (const expected of ['browser_open', 'browser_page', 'browser_act', 'browser_console', 'browser_close', 'browser_doctor']) {
        assert.ok(minimalTools.includes(expected), `missing ${expected}`)
      }
      const actSchema = (await minimal.client.listTools()).tools.find(tool => tool.name === 'browser_act')
      assert.equal(actSchema.inputSchema.properties.intent, undefined)
      passed.push('--no-eval/--no-screenshots/--no-jev withdrew their tools')
    } finally {
      const minimalPid = minimal.transport.pid
      await minimal.client.close()
      if (minimalPid !== null) assert.ok(await waitGone(minimalPid), 'the minimal server exited')
    }
  } finally {
    const pid = first.transport.pid
    await first.client.close().catch(() => {})
    if (pid !== null) assert.ok(await waitGone(pid), 'the server process exited when the client closed')
  }

  // The profile lock is released only when the session ends; its absence is the proof that it did.
  const second = await startServer()
  await second.client.close()
  assert.ok(!existsSync(join(STATE_ROOT, 'profiles', PROFILE, '.browser-use-mcp.lock')), 'the profile lock was released')
  passed.push('the server shut down cleanly and released its profile lock')

  // No daemon file for this test's sessions survives the shutdown either.
  const daemonLeftovers = readdirSync(daemonRuntimeDir()).filter(name => name.startsWith(`bu-browser-use-mcp-${PROFILE}`))
  assert.deepEqual(daemonLeftovers, [], `daemon files left behind: ${daemonLeftovers.join(', ')}`)
  passed.push('no browser-harness daemon files were left behind')

  // A scratch profile directory left by a crashed run is clearable; this one is only used by the test.
  rmSync(join(STATE_ROOT, 'profiles', PROFILE), { recursive: true, force: true })

  console.log(passed.map((line, index) => `${index + 1}. ${line}`).join('\n'))
  console.log(`\nPASS: ${passed.length} stdio end-to-end checks; a real headless Chrome, no model calls`)
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
})
