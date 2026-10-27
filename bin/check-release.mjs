#!/usr/bin/env node
/**
 * The release gate: the manifest, the changelog, the tree, and (when given) the tag must agree.
 *
 * `npm publish` refuses to run when this fails (`prepublishOnly`), the CI job runs it on every push,
 * and the release workflow runs it again on the tag — so a version cannot reach npm from a tree that
 * does not actually contain what it claims. It looks at the *packed* file list, not at the working
 * tree, because that is what npm will publish.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const errors = []
const fail = message => errors.push(message)
const read = path => readFileSync(join(ROOT, path), 'utf8')

const manifest = JSON.parse(read('package.json'))
const args = process.argv.slice(2)
const tagIndex = args.indexOf('--tag')
const tag = tagIndex === -1 ? undefined : args[tagIndex + 1]

/** The files the published package must contain. */
const REQUIRED = [
  'package.json',
  'bin/browser-use-mcp.mjs',
  'lib/cli.js', 'lib/config.js', 'lib/doctor.js', 'lib/engine.js', 'lib/http.js', 'lib/jev.js',
  'lib/log.js', 'lib/provision.js', 'lib/python.js', 'lib/render.js', 'lib/server.js',
  'lib/session.js', 'lib/sidecar.js', 'lib/tools.js',
  'sidecar/bridge.py',
  'vendor/requirements.txt',
  'vendor/jev-ultrafast.json',
  'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE',
  'docs/architecture.md', 'docs/clients.md', 'docs/config.md',
]
/** Nothing in here belongs in a published package. */
const FORBIDDEN = [/^test\//u, /^node_modules\//u, /^\.github\//u, /^dist\//u, /^AGENTS\.md$/u, /^\.npmrc$/u]

// --- Manifest identity -------------------------------------------------------------------------
if (manifest.name !== '@ricardochen1996/browser-use-mcp') {
  fail(`package name is ${JSON.stringify(manifest.name)}, not @ricardochen1996/browser-use-mcp`)
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version ?? '')) {
  fail(`version ${JSON.stringify(manifest.version)} is not a semver release version`)
}
if (tag !== undefined && tag !== `v${manifest.version}`) {
  fail(`tag ${JSON.stringify(tag)} does not match v${manifest.version}`)
}
if (manifest.license !== 'MIT') fail(`license is ${JSON.stringify(manifest.license)}, not MIT`)
if (typeof manifest.engines?.node !== 'string' || manifest.engines.node === '') {
  fail('package.json must declare engines.node (the sidecar needs a modern Node)')
}
if (manifest.publishConfig?.access !== 'public') {
  fail('package.json must set publishConfig.access to "public" (a scoped package is private by default)')
}

// --- Changelog ----------------------------------------------------------------------------------
const changelog = read('CHANGELOG.md')
if (!changelog.includes(`## [${manifest.version}]`)) {
  fail(`CHANGELOG.md has no "## [${manifest.version}]" section for this version`)
}

// --- What npm would actually publish ------------------------------------------------------------
let packed
try {
  const output = execFileSync(NPM, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  packed = JSON.parse(output)[0]
} catch (error) {
  fail(`npm pack --dry-run failed, so the package content cannot be checked: ${error?.message ?? error}`)
}

if (packed !== undefined) {
  const files = new Set(packed.files.map(file => file.path))
  for (const required of REQUIRED) {
    if (!files.has(required)) fail(`the published package is missing ${required}`)
  }
  for (const file of files) {
    if (FORBIDDEN.some(pattern => pattern.test(file))) fail(`the published package must not contain ${file}`)
  }
  const wheels = [...files].filter(file => file.startsWith('vendor/') && file.endsWith('.whl'))
  if (wheels.length !== 1) fail(`expected exactly one bundled engine wheel under vendor/, found ${wheels.length}`)
  const engine = JSON.parse(read('vendor/jev-ultrafast.json'))
  const expectedWheel = `vendor/jev_ultrafast-${engine.version}-py3-none-any.whl`
  if (wheels.length === 1 && wheels[0] !== expectedWheel) {
    fail(`the bundled wheel is ${wheels[0]}, but vendor/jev-ultrafast.json names ${expectedWheel}`)
  }
}

// --- The sidecar ships beside the JavaScript and is started by absolute path ---------------------
try {
  const mode = statSync(join(ROOT, 'bin', 'browser-use-mcp.mjs')).mode
  if ((mode & 0o111) === 0) fail('bin/browser-use-mcp.mjs is not executable')
} catch {
  fail('bin/browser-use-mcp.mjs does not exist')
}
try {
  read('sidecar/bridge.py')
} catch {
  fail('sidecar/bridge.py does not exist; reinstall the package')
}

if (errors.length > 0) {
  console.error(`release check failed (${manifest.name}@${manifest.version}):`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(`release check passed: ${manifest.name}@${manifest.version}, ${packed.files.length} packaged files`)
