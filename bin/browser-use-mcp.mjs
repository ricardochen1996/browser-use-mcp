#!/usr/bin/env node
/**
 * Executable bootstrap. This file runs before the Node version check, so it (and
 * `lib/bootstrap.js`) must stay parseable by old Node: no `??=`, no class fields, no top-level
 * await. Its only job is to hand over to a supported runtime, then load `lib/main.js`.
 */

import { fileURLToPath } from 'url'

import { relaunchIfNeeded } from '../lib/bootstrap.js'

const script = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)

if (!relaunchIfNeeded({ script: script, args: args })) {
  import('../lib/main.js')
    .then(function (main) {
      return main.run(args)
    })
    .catch(function (error) {
      process.stderr.write(`browser-use-mcp: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}
