/**
 * The executable's runtime bootstrap: the engine range, where a newer Node is looked for, and the
 * fact that the real CLI still answers once a supported runtime is in place.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { candidateNodes, findSupportedNode, isSupportedNode } from '../../lib/bootstrap.js'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'browser-use-mcp.mjs')
const POSIX = process.platform !== 'win32'

describe('isSupportedNode', () => {
  it('accepts the engine range', () => {
    for (const version of ['22.19.0', '22.19.1', '22.23.2', 'v22.23.2', '24.0.0', '25.4.1']) {
      assert.equal(isSupportedNode(version), true, version)
    }
  })

  it('refuses everything below it, and the odd Node 23 line', () => {
    for (const version of ['14.21.3', '16.20.2', '18.20.8', '20.11.0', '22.18.9', '23.6.0', '']) {
      assert.equal(isSupportedNode(version), false, version)
    }
  })

  it('refuses text that is not a version', () => {
    assert.equal(isSupportedNode('not-a-version'), false)
    assert.equal(isSupportedNode(undefined), false)
  })
})

describe('candidateNodes', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-use-mcp-bootstrap-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  function emptyFile(...parts) {
    const path = join(...parts)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')
    return path
  }

  it('takes PATH order first, then nvm newest-first, and deduplicates', () => {
    const first = emptyFile(root, 'path-a', 'node')
    const second = emptyFile(root, 'path-b', 'node')
    const nvm = join(root, 'home', '.nvm', 'versions', 'node')
    const nvm22 = emptyFile(nvm, 'v22.23.2', 'bin', 'node')
    const nvm18 = emptyFile(nvm, 'v18.20.8', 'bin', 'node')

    const candidates = candidateNodes({
      env: { PATH: [join(root, 'path-a'), join(root, 'path-b'), join(root, 'path-a')].join(delimiter) },
      platform: 'linux',
      home: join(root, 'home'),
    })

    assert.deepEqual(candidates.slice(0, 2), [first, second])
    assert.equal(candidates.filter(path => path === first).length, 1)
    assert.ok(candidates.includes(nvm22))
    assert.ok(candidates.includes(nvm18))
    assert.ok(candidates.indexOf(nvm22) < candidates.indexOf(nvm18))
  })
})

describe('findSupportedNode', () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-use-mcp-bootstrap-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  function fakeNode(name, version) {
    const path = join(root, name, 'node')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\necho ${version}\n`)
    chmodSync(path, 0o755)
    return path
  }

  it('skips an old node and takes the first supported one', { skip: !POSIX }, () => {
    const old = fakeNode('old', '18.20.8')
    const modern = fakeNode('modern', '22.19.0')
    const found = findSupportedNode({
      env: { PATH: [join(root, 'old'), join(root, 'modern')].join(delimiter) },
      platform: 'linux',
      home: join(root, 'empty-home'),
      execPath: join(root, 'not-the-running-node'),
    })
    assert.equal(found.path, modern)
    assert.equal(found.version, '22.19.0')
    assert.notEqual(found.path, old)
  })

  it('skips the executable already running', { skip: !POSIX }, () => {
    const modern = fakeNode('same', '22.19.0')
    const found = findSupportedNode({
      env: { PATH: join(root, 'same') },
      platform: 'linux',
      home: join(root, 'empty-home'),
      execPath: modern,
    })
    assert.ok(!found || found.path !== modern)
  })
})

describe('the executable', () => {
  it('still prints its version through the bootstrap', () => {
    const result = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/)
  })
})
