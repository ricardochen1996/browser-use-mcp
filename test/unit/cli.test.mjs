/**
 * The command line parser: words in, a command plus camelCase flags out, and a usage error that
 * names the bad token instead of throwing an unreadable parseArgs message.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { COMMANDS, parseCommandLine } from '../../lib/cli.js'

describe('commands', () => {
  it('defaults to serve', () => {
    assert.equal(parseCommandLine([]).command, 'serve')
    assert.equal(parseCommandLine(['--port', '9000']).command, 'serve')
  })

  it('accepts every documented command', () => {
    for (const command of COMMANDS) assert.equal(parseCommandLine([command]).command, command)
  })

  it('refuses an unknown command with the usage text', () => {
    assert.throws(() => parseCommandLine(['browse']), error => {
      assert.match(error.message, /unknown command "browse"/)
      assert.match(error.message, /Usage:/)
      return true
    })
  })

  it('refuses two commands', () => {
    assert.throws(() => parseCommandLine(['doctor', 'install']), /expected one command/)
  })
})

describe('flags', () => {
  it('maps every long option onto its camelCase field', () => {
    const { flags } = parseCommandLine([
      '--transport', 'http',
      '--host', '0.0.0.0',
      '--port', '7444',
      '--path', '/browser',
      '--mode', 'attach',
      '--attach-sharing', 'exclusive',
      '--cdp-endpoint', 'http://127.0.0.1:9333',
      '--executable', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '--profile', 'work',
      '--user-data-dir', '/tmp/profile',
      '--headless',
      '--python', '/usr/bin/python3.12',
      '--home', '/tmp/state',
      '--no-eval',
      '--no-screenshots',
      '--no-jev',
      '--jev-decider', 'chat',
      '--typesafe-base-url', 'http://typesafe',
      '--typesafe-model', 'jev-1',
      '--typesafe-api-key', 'key',
      '--text-model-base-url', 'http://model/v1',
      '--text-model', 'tiny',
      '--text-model-api-key', 'model-key',
      '--text-model-reasoning', 'none',
      '--request-timeout-ms', '90000',
      '--log-level', 'debug',
    ])
    assert.equal(flags.transport, 'http')
    assert.equal(flags.host, '0.0.0.0')
    assert.equal(flags.port, '7444')
    assert.equal(flags.path, '/browser')
    assert.equal(flags.mode, 'attach')
    assert.equal(flags.attachSharing, 'exclusive')
    assert.equal(flags.cdpEndpoint, 'http://127.0.0.1:9333')
    assert.equal(flags.executablePath, '/Applications/Chromium.app/Contents/MacOS/Chromium')
    assert.equal(flags.profile, 'work')
    assert.equal(flags.userDataDir, '/tmp/profile')
    assert.equal(flags.headless, true)
    assert.equal(flags.pythonPath, '/usr/bin/python3.12')
    assert.equal(flags.browserUseMcpHome, '/tmp/state')
    assert.equal(flags.noEval, true)
    assert.equal(flags.noScreenshots, true)
    assert.equal(flags.noJev, true)
    assert.equal(flags.jevDecider, 'chat')
    assert.equal(flags.typesafeBaseURL, 'http://typesafe')
    assert.equal(flags.typesafeModel, 'jev-1')
    assert.equal(flags.typesafeApiKey, 'key')
    assert.equal(flags.textModelBaseURL, 'http://model/v1')
    assert.equal(flags.textModel, 'tiny')
    assert.equal(flags.textModelApiKey, 'model-key')
    assert.equal(flags.textModelReasoning, 'none')
    assert.equal(flags.requestTimeoutMs, '90000')
    assert.equal(flags.logLevel, 'debug')
  })

  it('--headed explicitly asks for a visible browser', () => {
    assert.equal(parseCommandLine(['--headed']).flags.headless, false)
    assert.equal(parseCommandLine([]).flags.headless, undefined)
  })

  it('refuses an unknown option with the usage text', () => {
    assert.throws(() => parseCommandLine(['--colour', 'blue']), /Usage:/)
  })

  it('refuses a missing value', () => {
    assert.throws(() => parseCommandLine(['--port']), /Usage:/)
  })
})

describe('help and version', () => {
  it('recognises -h/--help and -v/--version', () => {
    assert.equal(parseCommandLine(['--help']).help, true)
    assert.equal(parseCommandLine(['-h']).help, true)
    assert.equal(parseCommandLine(['--version']).version, true)
    assert.equal(parseCommandLine(['-v']).version, true)
    assert.equal(parseCommandLine([]).help, false)
  })
})
