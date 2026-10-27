/**
 * End-to-end: the Jev policy wiring without a paid model call.
 *
 * `--jev-decider chat` makes the engine serve the System One protocol on loopback and lets an
 * OpenAI-compatible chat model answer it. This test serves that chat model itself, on loopback, so
 * the whole path is real — the sidecar's decision endpoint, the engine's policy loop, the text-value
 * request, and the MCP tool results — while the only model is the stub in this file.
 *
 * Two things are proved:
 *   1. a configured chat decider turns `browser_act({ intent })` into a decided TYPE_TEXT step whose
 *      value was written by the text model, verified on the page afterwards; `browser_goal` runs to
 *      a reported status against the same stub; and an explicit operation with an intent spends no
 *      decision at all.
 *   2. a server with no model configuration refuses both policy calls by naming the missing
 *      variable, as a normal tool result (not a failed call), and never reaches the browser.
 *
 * Run with: node test/e2e/intent.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createStubServer } from 'node:http'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BIN = join(ROOT, 'bin', 'browser-use-mcp.mjs')
const FIXTURE = pathToFileURL(join(ROOT, 'test', 'fixtures', 'fixture.html')).href
const STATE_ROOT = process.env.BROWSER_USE_MCP_TEST_HOME || join(tmpdir(), 'browser-use-mcp-e2e-home')
const PROFILE = 'e2e-intent'
const STUB_MODEL = 'stub-1'
const STUB_KEY = 'stub-key'
const passed = []

/**
 * The environment every server child starts with: a test state root, no model keys inherited from
 * the shell. `extra` is where a test puts the loopback stub's configuration.
 */
function serverEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(TYPESAFE_|TEXT_MODEL_|JEV_)/u.test(name)) delete env[name]
  }
  return {
    ...env,
    BROWSER_USE_MCP_HOME: STATE_ROOT,
    BROWSER_USE_MCP_MODE: 'launch',
    BROWSER_USE_MCP_HEADLESS: '1',
    BROWSER_USE_MCP_LOG_LEVEL: 'info',
    ...extra,
  }
}

/** One server child plus the MCP client on it. */
async function startServer(profile, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: serverEnv({ BROWSER_USE_MCP_PROFILE: profile, ...extraEnv }),
    stderr: 'pipe',
  })
  const stderr = []
  transport.stderr?.on('data', chunk => stderr.push(String(chunk)))
  const client = new Client({ name: 'browser-use-mcp-intent-e2e', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport, { timeout: 120_000 })
  return { client, transport, stderr: () => stderr.join('') }
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

/** Wait until a pid is gone, so a test can prove the server process ended. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitGone(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** The main Chrome processes (not helpers) still using one of this test's profiles. */
function browserPidsForProfile(profile) {
  const profileDir = join(STATE_ROOT, 'profiles', profile)
  let listing
  try {
    listing = execFileSync('ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const pids = []
  for (const line of listing.split('\n')) {
    if (!line.includes(`--user-data-dir=${profileDir}`)) continue
    if (line.includes('--type=')) continue // a Chrome helper, not the browser process
    const pid = Number(line.trim().split(/\s+/u)[0])
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid)
  }
  return pids
}

/** Stop a browser a failed run left on one of this test's profiles: a test never leaves Chrome. */
async function stopProfileBrowsers(profile) {
  for (const pid of browserPidsForProfile(profile)) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline && browserPidsForProfile(profile).length > 0) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  for (const pid of browserPidsForProfile(profile)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** Install the engine once into the test state root, reusing it on later runs. */
function ensureEngine() {
  execFileSync(process.execPath, [BIN, 'install'], {
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
  })
}

/**
 * What the stub chat model answers for one decision.
 *
 * The payload is the engine's flattened action offer: one key per executable action, whose value is
 * the line a model reads ("Enter or replace text in an editable field…: [2] Destination"). A real
 * model would reason about the goal; this one reads the goal this test wrote and matches the field.
 *
 * The goal run's goal says to finish and report DONE. The stub first types the destination and then
 * reports DONE once the field carries the value, so a goal run genuinely executes one step instead of
 * claiming a status without doing anything.
 */
function chooseAction(payload) {
  const actions = payload?.actions ?? {}
  const goal = String(payload?.goal ?? '')
  const destination = Object.keys(actions).find(key =>
    key.startsWith('TYPE_TEXT ') && /destination/iu.test(String(actions[key])))
  if (/report done|finish immediately|do nothing/iu.test(goal)) {
    const typed = Object.entries(actions).some(([key, description]) =>
      key.startsWith('TYPE_TEXT ') && /current_value=Lisbon/iu.test(String(description)))
    if (typed && Object.hasOwn(actions, 'DONE')) return { action: 'DONE', confidence: 0.9 }
    if (destination !== undefined) return { action: destination, confidence: 0.9 }
    if (Object.hasOwn(actions, 'DONE')) return { action: 'DONE', confidence: 0.9 }
  }
  if (destination !== undefined) return { action: destination, confidence: 0.9 }
  if (Object.hasOwn(actions, 'DONE')) return { action: 'DONE', confidence: 0.9 }
  const first = Object.keys(actions).find(key => key !== 'BLOCKED')
  return { action: first ?? 'BLOCKED', confidence: 0.9 }
}

/**
 * The OpenAI-compatible chat model the engine is pointed at, on loopback only.
 *
 * It answers the two shapes the engine asks a text model for, and records every request so the test
 * can prove the engine really called it — and only on loopback.
 */
function startChatModel() {
  const record = { requests: [], decisions: [], values: [] }
  const server = createStubServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not found"}')
        return
      }
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        body = {}
      }
      record.requests.push({
        remoteAddress: request.socket.remoteAddress,
        authorization: request.headers.authorization ?? '',
        model: body.model,
        responseFormat: body.response_format,
      })
      const messages = Array.isArray(body.messages) ? body.messages : []
      let payload
      try {
        payload = JSON.parse(String(messages.at(-1)?.content ?? ''))
      } catch {
        payload = undefined
      }
      let answer
      if (payload !== undefined && payload !== null && typeof payload === 'object' && payload.actions !== undefined) {
        answer = chooseAction(payload)
        record.decisions.push({ goal: payload.goal, actions: payload.actions, chosen: answer.action })
      } else {
        record.values.push({ context: payload })
        answer = { text: 'Lisbon' }
      }
      const reply = JSON.stringify({
        id: `stub-${record.requests.length}`,
        object: 'chat.completion',
        model: STUB_MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(reply),
      })
      response.end(reply)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        record,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

async function main() {
  for (const profile of [PROFILE, `${PROFILE}-plain`, `${PROFILE}-chatless`]) {
    await stopProfileBrowsers(profile)
    rmSync(join(STATE_ROOT, 'profiles', profile), { recursive: true, force: true })
  }
  ensureEngine()

  const stub = await startChatModel()
  let creds
  let plain
  try {
    creds = await startServer(PROFILE, {
      JEV_DECIDER: 'chat',
      TEXT_MODEL_BASE_URL: stub.url,
      TEXT_MODEL: STUB_MODEL,
      TEXT_MODEL_API_KEY: STUB_KEY,
      TEXT_MODEL_REASONING: 'thinking-disabled',
    })

    // 1. The tool surface offers browser_goal and browser_act's intent, and the doctor reports the
    // chat decider — without printing the key it was given.
    const tools = (await creds.client.listTools()).tools
    assert.ok(tools.some(tool => tool.name === 'browser_goal'), 'browser_goal is offered with Jev on')
    const actSchema = tools.find(tool => tool.name === 'browser_act')
    assert.ok(actSchema.inputSchema.properties.intent, 'browser_act offers the intent parameter')
    const doctor = await call(creds.client, 'browser_doctor', {}, 180_000)
    assert.match(doctor.text, /Jev\s+: on, chat decider: text model stub-1 at http:\/\/127\.0\.0\.1:\d+\/v1, key set/u, doctor.text)
    assert.doesNotMatch(doctor.text, new RegExp(STUB_KEY, 'u'), 'the doctor never prints the model key')
    passed.push('the server offered browser_goal and intent, and the doctor described the chat decider without the key')

    // 2. Open the fixture, then let the policy choose the step from an intent alone.
    const opened = await call(creds.client, 'browser_open', { url: FIXTURE }, 300_000)
    assert.equal(opened.isError, false, opened.text)
    const openedObservation = observationOf(opened.text)
    const decisionsBefore = stub.record.decisions.length
    const valuesBefore = stub.record.values.length
    const intent = await call(creds.client, 'browser_act', {
      observation: openedObservation,
      intent: 'Type the destination Lisbon',
    })
    assert.equal(intent.isError, false, intent.text)
    assert.match(intent.text, /Jev chose TYPE_TEXT on \[\d+\] .*\(confidence 0\.90\)/u, intent.text)
    assert.match(intent.text, /The text model \(stub-1\) wrote "Lisbon"/u, intent.text)
    assert.match(intent.text, /^Executed TYPE_TEXT on /mu, intent.text)
    const afterIntent = observationOf(intent.text)
    assert.ok(afterIntent > openedObservation, 'the decided step produced a new observation')
    passed.push('an intent alone made Jev choose TYPE_TEXT, and the text model wrote its value')

    // 3. The outcome is the page, not the tool's own claim: a later observation holds the value.
    const reread = await call(creds.client, 'browser_page')
    const destinationLine = elementLine(reread.text, /(search|text)box.*destination/iu).line
    assert.match(destinationLine, /"Lisbon"/u, reread.text)
    assert.ok(stub.record.decisions.length > decisionsBefore, 'the decision request reached the stub')
    assert.ok(stub.record.values.length > valuesBefore, 'the text-value request reached the stub')
    const intentDecision = stub.record.decisions.at(-1)
    assert.equal(intentDecision.goal, 'Type the destination Lisbon', 'the goal the engine offered is the intent')
    assert.match(intentDecision.chosen, /^TYPE_TEXT /u, `the intent decision named a TYPE_TEXT action: ${intentDecision.chosen}`)
    assert.ok(
      Object.keys(intentDecision.actions).some(key => key.startsWith('TYPE_TEXT ') && /destination/iu.test(intentDecision.actions[key])),
      `the decision offered the destination field: ${JSON.stringify(intentDecision.actions).slice(0, 800)}`,
    )
    passed.push('the decided destination value was verified on the page and both request shapes reached the stub')

    // 4. Every model request was loopback-only, carried the stub key per request, and asked for JSON.
    assert.ok(stub.record.requests.length >= 2, `the stub answered ${stub.record.requests.length} request(s)`)
    for (const request of stub.record.requests) {
      assert.match(request.remoteAddress, /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/u, 'only loopback reaches the stub')
      assert.equal(request.authorization, `Bearer ${STUB_KEY}`, 'the key travels on the per-call request')
      assert.equal(request.model, STUB_MODEL)
      assert.deepEqual(request.responseFormat, { type: 'json_object' })
    }
    passed.push(`${stub.record.requests.length} model requests went to the loopback stub with the per-call key`)

    // 5. An explicit operation with an intent is executed as given: no decision is spent on it.
    const decisionsBeforeWait = stub.record.decisions.length
    const waited = await call(creds.client, 'browser_act', {
      observation: observationOf(reread.text),
      operation: 'WAIT',
      intent: 'Type the destination Lisbon',
    })
    assert.equal(waited.isError, false, waited.text)
    assert.match(waited.text, /^Executed WAIT on /mu, waited.text)
    assert.equal(stub.record.decisions.length, decisionsBeforeWait, 'an explicit operation spends no decision')
    passed.push('an explicit operation with an intent was executed without asking the policy')

    // 6. browser_goal runs the same loop to a reported status against the same stub.
    const goal = await call(creds.client, 'browser_goal', {
      url: FIXTURE,
      goal: 'Finish immediately: the page is already open, so report DONE.',
    }, 300_000)
    assert.equal(goal.isError, false, goal.text)
    assert.match(goal.text, /Jev run finished with status done in \d+ ms over 1 action\(s\)\./u, goal.text)
    assert.match(goal.text, /1\. TYPE_TEXT Destination "Lisbon"/u, goal.text)
    assert.match(goal.text, /Generated text:\n  Destination = "Lisbon"/u, goal.text)
    assert.match(goal.text, /A reported status is not proof of the outcome/u, goal.text)
    const goalDecisions = stub.record.decisions.filter(
      decision => decision.goal === 'Finish immediately: the page is already open, so report DONE.',
    )
    assert.ok(goalDecisions.some(decision => /^TYPE_TEXT /u.test(decision.chosen)), 'the goal run chose a real action')
    assert.equal(goalDecisions.at(-1).chosen, 'DONE', 'the goal run then reported DONE')
    passed.push('browser_goal ran under the chat decider to a reported done status')

    // 7. No credentials: the same calls refuse with the variable to set, as normal tool results,
    // and nothing reaches a browser or a model.
    plain = await startServer(`${PROFILE}-plain`)
    const plainOpened = await call(plain.client, 'browser_open', { url: FIXTURE }, 300_000)
    assert.equal(plainOpened.isError, false, plainOpened.text)
    const plainObservation = observationOf(plainOpened.text)
    const requestsBeforeRefusal = stub.record.requests.length
    const refusedAct = await call(plain.client, 'browser_act', {
      observation: plainObservation,
      intent: 'Type the destination Lisbon',
    })
    assert.equal(refusedAct.isError, false, 'an unconfigured policy is a refusal, not a failed call')
    assert.match(refusedAct.text, /^Refused: TYPESAFE_API_KEY is required for browser_goal and browser_act intents, or pass --jev-decider chat with TEXT_MODEL_\*/u, refusedAct.text)
    const refusedGoal = await call(plain.client, 'browser_goal', { url: FIXTURE, goal: 'Type the destination Lisbon' })
    assert.equal(refusedGoal.isError, false, 'an unconfigured policy is a refusal, not a failed call')
    assert.match(refusedGoal.text, /^Refused: TYPESAFE_API_KEY .*--jev-decider chat/u, refusedGoal.text)
    const plainReread = await call(plain.client, 'browser_page')
    assert.ok(observationOf(plainReread.text) > plainObservation, 'the refused calls did not move the observation')
    assert.doesNotMatch(elementLine(plainReread.text, /(search|text)box.*destination/iu).line, /"Lisbon"/u,
      'the refused intent executed nothing on the page')
    assert.equal(stub.record.requests.length, requestsBeforeRefusal, 'a refused policy call never reaches a model')
    passed.push('without credentials both policy calls refused by naming TYPESAFE_API_KEY and executed nothing')

    // 8. A chat decider without the text-model variables is refused before anything runs.
    const chatless = await startServer(`${PROFILE}-chatless`, { JEV_DECIDER: 'chat' })
    try {
      const chatlessGoal = await call(chatless.client, 'browser_goal', { url: FIXTURE, goal: 'Type the destination Lisbon' })
      assert.equal(chatlessGoal.isError, false, chatlessGoal.text)
      assert.match(chatlessGoal.text, /^Refused: --jev-decider chat needs TEXT_MODEL_BASE_URL and TEXT_MODEL/u, chatlessGoal.text)
    } finally {
      const chatlessPid = chatless.transport.pid
      await chatless.client.close()
      if (chatlessPid !== null) assert.ok(await waitGone(chatlessPid), 'the chatless server exited')
    }
    passed.push('a chat decider missing TEXT_MODEL_BASE_URL/TEXT_MODEL refused with the variables to set')
  } finally {
    if (creds !== undefined) {
      const pid = creds.transport.pid
      await creds.client.close().catch(() => {})
      if (pid !== null) await waitGone(pid)
    }
    if (plain !== undefined) {
      const pid = plain.transport.pid
      await plain.client.close().catch(() => {})
      if (pid !== null) await waitGone(pid)
    }
    await stub.close()
    for (const profile of [PROFILE, `${PROFILE}-plain`, `${PROFILE}-chatless`]) {
      await stopProfileBrowsers(profile)
      rmSync(join(STATE_ROOT, 'profiles', profile), { recursive: true, force: true })
    }
  }

  console.log(passed.map((line, index) => `${index + 1}. ${line}`).join('\n'))
  console.log(`\nPASS: ${passed.length} Jev intent end-to-end checks; the model is a loopback stub, no paid calls`)
}

main().catch(error => {
  console.error(`FAIL: ${error?.stack ?? error}`)
  process.exitCode = 1
})
