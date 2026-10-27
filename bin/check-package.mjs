#!/usr/bin/env node
/**
 * Build the exact tarball that would be published, verify its contents, and record its identity.
 *
 * CI uploads `dist/` as an artifact and the release workflow can publish that file instead of
 * repacking, so what a release says it verified is what reaches the registry. The file also prints a
 * human summary, which makes a local `npm run release:pack` a useful last look before `npm publish`.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const DIST = join(ROOT, 'dist')

/** The required and forbidden entries a publishable tarball must respect. */
const REQUIRED = ['package.json', 'bin/browser-use-mcp.mjs', 'lib/server.js', 'sidecar/bridge.py', 'vendor/requirements.txt', 'README.md', 'LICENSE', 'NOTICE']
const FORBIDDEN = [/^test\//u, /^node_modules\//u, /^\.github\//u, /^dist\//u, /^AGENTS\.md$/u]

mkdirSync(DIST, { recursive: true })
const output = execFileSync(NPM, ['pack', '--json', '--ignore-scripts', '--pack-destination', DIST], {
  cwd: ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})
const packed = JSON.parse(output)[0]
const tarball = join(DIST, packed.filename)
const bytes = readFileSync(tarball)
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
if (packed.integrity !== undefined && packed.integrity !== integrity) {
  throw new Error(`the tarball integrity npm reported (${packed.integrity}) does not match the file on disk (${integrity})`)
}

const files = new Set(packed.files.map(file => file.path))
const missing = REQUIRED.filter(required => !files.has(required))
const forbidden = [...files].filter(file => FORBIDDEN.some(pattern => pattern.test(file)))
if (missing.length > 0 || forbidden.length > 0) {
  throw new Error(`the tarball is not publishable: missing ${missing.join(', ') || 'nothing'}; containing ${forbidden.join(', ') || 'nothing forbidden'}`)
}

const record = {
  name: packed.name,
  version: packed.version,
  filename: packed.filename,
  integrity,
  bytes: bytes.length,
  files: packed.files.length,
  shasum: packed.shasum,
}
writeFileSync(join(DIST, 'pack.json'), `${JSON.stringify(record, null, 2)}\n`)
console.log(`packed ${record.name}@${record.version}: ${record.filename} (${record.files} files, ${(record.bytes / 1024).toFixed(1)} KiB)`)
console.log(`integrity ${record.integrity}`)
