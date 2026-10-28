/**
 * Unit tests for the provisioning half of browser-use-mcp: the path logic of lib/provision.js, the
 * interpreter probing of lib/python.js, and one real install into a throwaway state root.
 *
 * The last test is deliberately end-to-end. The whole point of `ensureEngine` is that a machine
 * with nothing installed ends up with a sidecar-capable virtualenv, and a mocked installer would
 * not prove that; it downloads nothing when uv's cache is warm and about a megabyte of wheels on a
 * cold cache. The temp home is removed afterwards and the user's own state root is never touched.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { basePythons, environmentPython, findUv, probePython } from '../../lib/python.js'
import {
  PACKAGE_ROOT,
  bundledEngine,
  duration,
  environmentRecord,
  installEngine,
  installHint,
  installStatus,
  ownEnvironment,
  requirementsPath,
  stateRoot,
} from '../../lib/provision.js'
import {
  engineIsCurrent,
  ensureEngine,
  forgetEngine,
  inspectEngine,
  installable,
  interpreterCandidates,
  reportText,
} from '../../lib/engine.js'

/** A resolved-config stand-in; the provisioner only reads these fields. */
function configFor(home) {
  return {
    browserUseMcpHome: home,
    pythonPath: '',
    mode: 'launch',
    cdpEndpoint: '',
    executablePath: '',
    jev: { enabled: true, decider: 'typesafe' },
  }
}

test('stateRoot is absolute and names the managed environment beside it', () => {
  const home = join(tmpdir(), 'browser-use-mcp-state-root')
  assert.equal(stateRoot({ browserUseMcpHome: home }), resolve(home))
  assert.equal(stateRoot({ browserUseMcpHome: 'relative-state' }), resolve('relative-state'))
  // The documented default, applied when the configuration arrives without it.
  assert.equal(stateRoot({}), join(homedir(), '.browser-use-mcp'))
  assert.equal(ownEnvironment({ browserUseMcpHome: home }), join(resolve(home), 'env'))
})

test('environmentPython is the platform-specific interpreter inside a virtualenv', () => {
  const environment = join(tmpdir(), 'browser-use-mcp-venv')
  const expected = process.platform === 'win32'
    ? join(environment, 'Scripts', 'python.exe')
    : join(environment, 'bin', 'python')
  assert.equal(environmentPython(environment), expected)
})

test('bundledEngine reads the engine version from the wheel that ships here', () => {
  const engine = bundledEngine()
  assert.ok(engine, 'the package must carry vendor/jev_ultrafast-*.whl')
  assert.equal(engine.version, '0.1.2')
  assert.equal(engine.path, join(PACKAGE_ROOT, 'vendor', 'jev_ultrafast-0.1.2-py3-none-any.whl'))
  assert.ok(existsSync(engine.path))
  assert.ok(existsSync(requirementsPath()), 'the hash-pinned requirements must ship too')
})

test('duration reads like a person wrote it', () => {
  assert.equal(duration(0), '0s')
  assert.equal(duration(999), '1s')
  assert.equal(duration(42000), '42s')
  assert.equal(duration(60000), '1m')
  assert.equal(duration(65000), '1m 5s')
  assert.equal(duration(600000), '10m')
})

test('installHint names the CLI command that installs now', () => {
  const hint = installHint({})
  assert.match(hint, /^node .+bin[/\\]browser-use-mcp\.mjs install$/u)
  assert.ok(hint.includes(PACKAGE_ROOT), 'the hint has to work from another directory')
})

test('basePythons orders the configured interpreter, then uv, then system Pythons', () => {
  const configured = join(tmpdir(), 'configured-python')
  const withConfigured = basePythons({ pythonPath: configured })
  assert.deepEqual(withConfigured[0], { command: configured, prefix: [], source: 'pythonPath' })

  const discovered = basePythons({ pythonPath: '' })
  const system = discovered.filter(item => item.source === 'system python').map(item => item.command)
  const expected = process.platform === 'win32'
    ? ['python.exe']
    : ['python3.14', 'python3.13', 'python3.12', 'python3']
  assert.deepEqual(system, expected)
  assert.ok(discovered.every(item => item.prefix.length === 0))
  if (findUv() !== undefined) {
    const uv = discovered.findIndex(item => item.source === 'uv')
    assert.ok(uv >= 0, 'uv on PATH has to be a candidate')
    assert.ok(uv < discovered.findIndex(item => item.source === 'system python'),
      'uv is tried before a system Python')
  }
})

test('findUv resolves uv through PATH and nowhere else', () => {
  assert.equal(findUv({ PATH: '' }), undefined)
  assert.equal(findUv({}), undefined)
  const uv = findUv(process.env)
  if (uv !== undefined) assert.ok(existsSync(uv))
})

test('installable is false only for an explicitly configured interpreter', () => {
  assert.equal(installable({}), true)
  assert.equal(installable({ pythonPath: '' }), true)
  assert.equal(installable({ pythonPath: join(tmpdir(), 'python') }), false)
  const configured = join(tmpdir(), 'python')
  const candidates = interpreterCandidates({ browserUseMcpHome: join(tmpdir(), 'candidates'), pythonPath: configured })
  assert.deepEqual(candidates.map(item => item.source), ['pythonPath'])
})

test('interpreterCandidates starts at the managed environment and never probes uv', () => {
  const home = join(tmpdir(), 'browser-use-mcp-candidates')
  const candidates = interpreterCandidates(configFor(home))
  assert.equal(candidates[0].source, 'managed environment')
  assert.equal(candidates[0].command, environmentPython(ownEnvironment(configFor(home))))
  assert.ok(candidates.every(item => item.source !== 'uv'), 'uv builds environments, it is not an interpreter')
  assert.ok(candidates.every(item => item.cwd === PACKAGE_ROOT))
})

test('probePython reports a missing interpreter instead of throwing', async () => {
  const result = await probePython(join(tmpdir(), 'browser-use-mcp-no-such-python'))
  assert.equal(typeof result.failure, 'string')
  assert.match(result.failure, /could not be started/u)
})

test('this machine exposes a usable Python 3.12+ candidate', async t => {
  const candidates = basePythons({ pythonPath: '' }).filter(item => item.source !== 'uv')
  const usable = []
  for (const candidate of candidates) {
    const result = await probePython(candidate.command, candidate.prefix)
    if (result.failure !== undefined) continue
    if (result.major > 3 || (result.major === 3 && result.minor >= 12)) usable.push({ candidate, result })
  }
  if (usable.length === 0) {
    t.skip(`no Python 3.12+ on this machine (tried ${candidates.map(item => item.command).join(', ')})`)
    return
  }
  assert.ok(usable.length >= 1)
  for (const { result } of usable) assert.match(result.version, /^\d+\.\d+\.\d+$/u)
})

test('inspectEngine reports attach problems with fixes instead of throwing', async () => {
  const config = configFor(join(tmpdir(), 'browser-use-mcp-inspect-only'))
  const unreachable = await inspectEngine({
    ...config,
    mode: 'attach',
    cdpEndpoint: 'http://127.0.0.1:9/',
  })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.attach.checked, true)
  assert.equal(unreachable.attach.reachable, false)
  assert.ok(unreachable.problems.some(item => item.code === 'attach_unreachable'))
  for (const item of unreachable.problems) {
    assert.equal(typeof item.code, 'string')
    assert.equal(typeof item.message, 'string')
    assert.equal(typeof item.fix, 'string')
    assert.ok(item.fix.length > 0)
  }
  // A malformed endpoint is the configuration's bug, but it still must not escape this function.
  const malformed = await inspectEngine({ ...config, mode: 'attach', cdpEndpoint: 'not a url' })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.attach.code, 'attach_unchecked')
})

test('inspectEngine leaves the browser question to the doctor and the first open, not to install', async () => {
  const config = configFor(join(tmpdir(), 'browser-use-mcp-install-only'))
  // No browser is running at this endpoint and no Chrome need exist on this machine: `install` is
  // about the engine, so neither may turn into a problem that makes it exit non-zero.
  const report = await inspectEngine({
    ...config,
    command: 'install',
    mode: 'attach',
    cdpEndpoint: 'http://127.0.0.1:9/',
  })
  assert.equal(report.attach, undefined)
  assert.equal(report.browser, undefined)
  assert.deepEqual(report.problems.filter(item => item.code.startsWith('attach_') || item.code === 'no_browser'), [])
  // A doctor or a server still checks it: the default mode drives a browser that must be there.
  const doctor = await inspectEngine({
    ...config,
    command: 'doctor',
    mode: 'attach',
    cdpEndpoint: 'http://127.0.0.1:9/',
  })
  assert.equal(doctor.attach?.reachable, false)
  assert.ok(doctor.problems.some(item => item.code === 'attach_unreachable'))
})

test('ensureEngine provisions a real environment into a temp home and reuses it', { timeout: 300000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'browser-use-mcp-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = configFor(home)
  const environment = ownEnvironment(config)
  forgetEngine()

  assert.equal(environmentRecord(environment), undefined, 'a fresh home has no install record')
  assert.equal(installStatus(), undefined, 'nothing has run in this process yet')

  // A lock left behind by an install that was killed must not block this one.
  const lock = join(home, 'install.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner.json'),
    JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }))

  const started = Date.now()
  const report = await ensureEngine(config)
  const took = Date.now() - started
  assert.equal(report.ok, true, reportText(report))
  assert.equal(report.engine?.engine, '0.1.2')
  assert.equal(report.engine?.browserHarness, '0.1.13')
  assert.deepEqual(report.problems, [])
  assert.equal(report.interpreter.source, 'managed environment')
  const [major, minor] = report.engine.python.split('.').map(Number)
  assert.ok(major > 3 || (major === 3 && minor >= 12), `unexpected Python ${report.engine.python}`)
  assert.ok(took < 240000, `the first install took ${took}ms`)

  assert.ok(!existsSync(lock), 'the stale lock has to be reclaimed and released')
  assert.ok(existsSync(join(home, 'install.json')), 'the install record has to be written')
  const record = environmentRecord(environment)
  assert.equal(record.environment, environment)
  assert.equal(record.engine, '0.1.2')
  assert.equal(record.browserHarness, '0.1.13')
  assert.ok(['uv', 'python'].includes(record.strategy), `unexpected strategy ${record.strategy}`)
  assert.match(String(record.installedAt), /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(installStatus().state, 'installed')

  // The second call has to reuse the environment instead of installing it again.
  const second = Date.now()
  const again = await ensureEngine(config)
  assert.equal(again.ok, true, reportText(again))
  assert.ok(Date.now() - second < 5000, 'a second ensureEngine must not reinstall')
  assert.equal(again.engine?.engine, '0.1.2')

  const reused = await installEngine(config)
  assert.equal(reused.ok, true)
  assert.equal(reused.environment, environment)
  assert.equal(reused.engine, '0.1.2')
  assert.equal(reused.browserHarness, '0.1.13')

  // Concurrent callers must join one install, not race two into the same directory.
  const [first, concurrent] = await Promise.all([
    installEngine(config, { force: true }),
    installEngine(config, { force: true }),
  ])
  assert.equal(first.ok, true, first.error)
  assert.equal(concurrent.ok, true, concurrent.error)
  assert.equal(first.environment, concurrent.environment)
  assert.equal(first.strategy, concurrent.strategy)
  assert.equal(first.engine, concurrent.engine)
  assert.equal(first.browserHarness, concurrent.browserHarness)
})

/** The site-packages directory inside one managed environment, as its Python lays it out. */
function sitePackagesFor(environment) {
  const windows = process.platform === 'win32'
  const lib = windows ? join(environment, 'Lib') : join(environment, 'lib')
  const directory = windows
    ? lib
    : join(lib, readdirSync(lib).find(name => name.startsWith('python3')) ?? 'python3')
  return join(directory, 'site-packages')
}

test('an engine that is not the version this package ships is not current', () => {
  const bundled = bundledEngine()
  assert.equal(engineIsCurrent({ engine: { engine: bundled.version } }), true)
  assert.equal(engineIsCurrent({ engine: { engine: '0.0.9' } }), false)
  assert.equal(engineIsCurrent({}), false, 'no probed engine is not a current engine')
  assert.equal(engineIsCurrent(undefined), false)
})

test('ensureEngine rebuilds an environment an earlier release built', { timeout: 300000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'browser-use-mcp-upgrade-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = configFor(home)
  const environment = ownEnvironment(config)
  forgetEngine()

  const first = await ensureEngine(config)
  assert.equal(first.ok, true, reportText(first))
  assert.equal(engineIsCurrent(first), true)

  // Make the installed engine look like an earlier release built it: relabelling its distribution
  // metadata is what the probe reads, so this asks the upgrade question without a second wheel.
  const site = sitePackagesFor(environment)
  const installed = readdirSync(site).find(name => /^jev_ultrafast-.*\.dist-info$/u.test(name))
  assert.ok(installed, 'the installed engine has a dist-info directory')
  const stale = 'jev_ultrafast-0.0.9.dist-info'
  renameSync(join(site, installed), join(site, stale))
  const metadata = join(site, stale, 'METADATA')
  writeFileSync(metadata, readFileSync(metadata, 'utf8').replace(/^Version: .*$/mu, 'Version: 0.0.9'))

  forgetEngine()
  const outdated = await inspectEngine(config, { fresh: true })
  assert.equal(outdated.engine?.engine, '0.0.9', reportText(outdated))
  assert.equal(engineIsCurrent(outdated), false)
  assert.equal(outdated.ok, false, 'an outdated engine is not "ready"')
  assert.ok(outdated.problems.some(item => item.code === 'engine_outdated'), JSON.stringify(outdated.problems))

  // A configured interpreter is the caller's own environment: the same finding is a warning there,
  // with the command that installs the bundled wheel, and browser calls keep working with it.
  const configured = await inspectEngine(
    { ...config, pythonPath: environmentPython(environment) },
    { fresh: true },
  )
  assert.equal(configured.ok, true, 'a configured interpreter is not refused for an old engine')
  assert.equal(configured.engine?.engine, '0.0.9')
  assert.deepEqual(configured.problems, [])
  assert.ok(configured.warnings.some(item => item.code === 'engine_outdated'), JSON.stringify(configured.warnings))
  assert.match(configured.warnings[0].fix, /uv pip install --python/u)
  assert.match(reportText(configured), /Warning  : the browser engine in use is jev_ultrafast 0\.0\.9/u)
  const leftAlone = await ensureEngine({ ...config, pythonPath: environmentPython(environment) })
  assert.equal(leftAlone.ok, true)
  assert.equal(leftAlone.engine?.engine, '0.0.9', 'a configured interpreter is never reinstalled by this server')

  // The upgrade question is not "does it import" but "is it the version beside this package".
  const repaired = await ensureEngine(config)
  assert.equal(repaired.ok, true, reportText(repaired))
  assert.equal(repaired.engine?.engine, bundledEngine().version)
  assert.equal(engineIsCurrent(repaired), true)
  assert.equal(environmentRecord(environment).engine, bundledEngine().version)
})
