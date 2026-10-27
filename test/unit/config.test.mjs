/**
 * The configuration is the one place flags and environment meet, so it is where most of the
 * easy-to-get-wrong behaviour lives: precedence, validation, and the "never print a secret" rule.
 */

import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { ConfigError, connectionFor, describeConfig, expandHome, resolveConfig } from '../../lib/config.js'

const clean = () => ({ env: {}, cwd: '/work' })

describe('resolveConfig defaults', () => {
  it('resolves the documented defaults', () => {
    const config = resolveConfig(clean())
    assert.equal(config.command, 'serve')
    assert.equal(config.transport, 'stdio')
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 7331)
    assert.equal(config.path, '/mcp')
    assert.equal(config.mode, 'launch')
    assert.equal(config.profile, 'default')
    assert.equal(config.userDataDir, join(homedir(), '.browser-use-mcp', 'profiles', 'default'))
    assert.equal(config.headless, false)
    assert.equal(config.allowEval, true)
    assert.equal(config.allowScreenshots, true)
    assert.equal(config.jev.enabled, true)
    assert.equal(config.jev.decider, 'typesafe')
    assert.equal(config.requestTimeoutMs, 180_000)
    assert.equal(config.httpIdleMs, 900_000)
    assert.equal(config.logLevel, 'info')
  })

  it('reads the command from the parser and keeps it on the resolved object', () => {
    assert.equal(resolveConfig({ command: 'doctor', ...clean() }).command, 'doctor')
  })
})

describe('precedence', () => {
  it('lets a flag win over the environment and the environment over the default', () => {
    const config = resolveConfig({
      flags: { transport: 'http', port: '9100' },
      env: {
        BROWSER_USE_MCP_TRANSPORT: 'stdio',
        BROWSER_USE_MCP_PORT: '9200',
        BROWSER_USE_MCP_PROFILE: 'from-env',
        BROWSER_USE_MCP_LOG_LEVEL: 'debug',
      },
      cwd: '/work',
    })
    assert.equal(config.transport, 'http')
    assert.equal(config.port, 9100)
    assert.equal(config.profile, 'from-env')
    assert.equal(config.logLevel, 'debug')
  })

  it('an undefined flag does not shadow a set environment variable', () => {
    const config = resolveConfig({ flags: { host: undefined }, env: { BROWSER_USE_MCP_HOST: '0.0.0.0' }, cwd: '/work' })
    assert.equal(config.host, '0.0.0.0')
  })
})

describe('connection mode', () => {
  it('a cdp endpoint implies attach mode', () => {
    const config = resolveConfig({
      flags: { cdpEndpoint: 'http://127.0.0.1:9333' },
      ...clean(),
    })
    assert.equal(config.mode, 'attach')
    assert.equal(config.cdpEndpoint, 'http://127.0.0.1:9333')
  })

  it('refuses an endpoint with a contradictory launch mode instead of ignoring one of them', () => {
    assert.throws(
      () => resolveConfig({ flags: { mode: 'launch', cdpEndpoint: 'ws://127.0.0.1:9333/devtools/browser/x' }, ...clean() }),
      ConfigError,
    )
  })

  it('accepts attach mode without an endpoint (the browser you browse with)', () => {
    assert.equal(resolveConfig({ flags: { mode: 'attach' }, ...clean() }).mode, 'attach')
  })

  it('reads the HTTP idle timeout from the environment and validates it', () => {
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_HTTP_IDLE_MS: '5000' }, cwd: '/work' }).httpIdleMs, 5_000)
    assert.throws(() => resolveConfig({ env: { BROWSER_USE_MCP_HTTP_IDLE_MS: 'soon' }, cwd: '/work' }), ConfigError)
    assert.throws(() => resolveConfig({ env: { BROWSER_USE_MCP_HTTP_IDLE_MS: '10' }, cwd: '/work' }), ConfigError)
  })

  it('refuses a malformed endpoint', () => {
    assert.throws(() => resolveConfig({ flags: { cdpEndpoint: '127.0.0.1:9333' }, ...clean() }), ConfigError)
    assert.throws(() => resolveConfig({ flags: { cdpEndpoint: 'http://a b' }, ...clean() }), ConfigError)
  })
})

describe('tool surface switches', () => {
  it('--no-eval and --no-screenshots withdraw their tools', () => {
    const config = resolveConfig({ flags: { noEval: true, noScreenshots: true }, ...clean() })
    assert.equal(config.allowEval, false)
    assert.equal(config.allowScreenshots, false)
  })

  it('the environment can make the same answer either way', () => {
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_NO_EVAL: '1' }, cwd: '/work' }).allowEval, false)
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_EVAL: '0' }, cwd: '/work' }).allowEval, false)
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_EVAL: '1' }, cwd: '/work' }).allowEval, true)
  })

  it('--no-jev withdraws the policy', () => {
    assert.equal(resolveConfig({ flags: { noJev: true }, ...clean() }).jev.enabled, false)
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_NO_JEV: '1' }, cwd: '/work' }).jev.enabled, false)
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_JEV: 'off' }, cwd: '/work' }).jev.enabled, false)
  })

  it('collects the Jev settings from flags and environment', () => {
    const config = resolveConfig({
      flags: { jevDecider: 'chat', textModel: 'tiny-model' },
      env: {
        TEXT_MODEL_BASE_URL: 'http://127.0.0.1:9999/v1',
        TEXT_MODEL_API_KEY: 'secret',
        TEXT_MODEL_HEADERS: '{"x-tenant":"a"}',
      },
      cwd: '/work',
    })
    assert.equal(config.jev.decider, 'chat')
    assert.equal(config.jev.textModel.model, 'tiny-model')
    assert.equal(config.jev.textModel.baseURL, 'http://127.0.0.1:9999/v1')
    assert.equal(config.jev.textModel.apiKey, 'secret')
    assert.deepEqual(config.jev.textModel.headers, { 'x-tenant': 'a' })
  })
})

describe('validation', () => {
  const cases = [
    [{ flags: { transport: 'sse' } }, 'transport'],
    [{ flags: { port: 'abc' } }, 'port'],
    [{ flags: { port: '70000' } }, 'port'],
    [{ flags: { path: 'm c p' } }, 'path'],
    [{ flags: { mode: 'sometimes' } }, 'mode'],
    [{ flags: { profile: '../escape' } }, 'profile'],
    [{ flags: { jevDecider: 'oracle' } }, 'decider'],
    [{ flags: { textModelReasoning: 'max' } }, 'reasoning'],
    [{ flags: { requestTimeoutMs: '0' } }, 'request-timeout-ms'],
    [{ flags: { logLevel: 'verbose' } }, 'log-level'],
    [{ env: { TEXT_MODEL_HEADERS: '[1,2]' } }, 'TEXT_MODEL_HEADERS'],
    [{ env: { TEXT_MODEL_HEADERS: '{bad' } }, 'TEXT_MODEL_HEADERS'],
    [{ env: { BROWSER_USE_MCP_HEADLESS: 'maybe' } }, 'BROWSER_USE_MCP_HEADLESS'],
    [{ env: { TYPESAFE_BASE_URL: 'ftp://x' } }, 'typesafe-base-url'],
  ]
  for (const [input, needle] of cases) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      assert.throws(() => resolveConfig({ ...input, cwd: '/work' }), error => {
        assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error}`)
        assert.ok(error.message.includes(needle), `${error.message} should mention ${needle}`)
        return true
      })
    })
  }

  it('the path gets a leading slash rather than failing', () => {
    assert.equal(resolveConfig({ flags: { path: 'mcp' }, ...clean() }).path, '/mcp')
  })

  it('headless accepts --headless, --headed, and the environment', () => {
    assert.equal(resolveConfig({ flags: { headless: true }, ...clean() }).headless, true)
    assert.equal(resolveConfig({ flags: { headless: false }, ...clean() }).headless, false)
    assert.equal(resolveConfig({ env: { BROWSER_USE_MCP_HEADLESS: '1' }, cwd: '/work' }).headless, true)
  })
})

describe('paths', () => {
  it('expands a leading ~', () => {
    assert.equal(expandHome('~'), homedir())
    assert.equal(expandHome('~/x'), join(homedir(), 'x'))
    assert.equal(expandHome('/abs'), '/abs')
  })

  it('resolves relative paths against the working directory', () => {
    const config = resolveConfig({ flags: { browserUseMcpHome: 'state' }, ...clean() })
    assert.equal(config.browserUseMcpHome, '/work/state')
  })

  it('a configured user data directory wins over the managed profile path', () => {
    const config = resolveConfig({ flags: { userDataDir: '/tmp/profile', profile: 'other' }, ...clean() })
    assert.equal(config.userDataDir, '/tmp/profile')
    assert.equal(config.profile, 'other')
  })
})

describe('connectionFor', () => {
  it('sends only the parameters the sidecar needs for this mode', () => {
    const launch = connectionFor(resolveConfig(clean()))
    assert.deepEqual(launch, {
      mode: 'launch',
      userDataDir: join(homedir(), '.browser-use-mcp', 'profiles', 'default'),
    })
    const attach = connectionFor(resolveConfig({ flags: { cdpEndpoint: 'http://127.0.0.1:9333', headless: true }, ...clean() }))
    assert.equal(attach.mode, 'attach')
    assert.equal(attach.cdpEndpoint, 'http://127.0.0.1:9333')
    assert.equal(attach.headless, true)
  })

  it('lets an HTTP session override its profile and headless switch', () => {
    const config = resolveConfig(clean())
    const session = connectionFor(config, { userDataDir: '/work/profiles/default-abc123', headless: true })
    assert.equal(session.userDataDir, '/work/profiles/default-abc123')
    assert.equal(session.headless, true)
  })
})

describe('describeConfig', () => {
  it('never prints a secret', () => {
    const config = resolveConfig({
      flags: { typesafeApiKey: 'sk-very-secret', textModelApiKey: 'also-secret', headless: true },
      env: {},
      cwd: '/work',
    })
    const text = describeConfig(config).join('\n')
    assert.ok(!text.includes('sk-very-secret'), 'the TypeSafe key must not be printed')
    assert.ok(!text.includes('also-secret'), 'the text model key must not be printed')
    assert.ok(text.includes('key set'), 'the doctor still says a key is set')
  })

  it('formats a sub-minute HTTP idle timeout in seconds', () => {
    const config = resolveConfig({ flags: { transport: 'http' }, env: { BROWSER_USE_MCP_HTTP_IDLE_MS: '90000' }, cwd: '/work' })
    const text = describeConfig(config).join('\n')
    assert.ok(text.includes('idle MCP sessions are closed after 2 minutes'), text)
    const short = resolveConfig({ flags: { transport: 'http' }, env: { BROWSER_USE_MCP_HTTP_IDLE_MS: '1500' }, cwd: '/work' })
    assert.ok(describeConfig(short).join('\n').includes('after 1.5 seconds'))
  })

  it('describes attach mode and an HTTP transport', () => {
    const config = resolveConfig({
      flags: { transport: 'http', port: '7331', cdpEndpoint: 'http://127.0.0.1:9333' },
      ...clean(),
    })
    const text = describeConfig(config).join('\n')
    assert.ok(text.includes('Streamable HTTP http://127.0.0.1:7331/mcp'))
    assert.ok(text.includes('attach to http://127.0.0.1:9333'))
  })
})
