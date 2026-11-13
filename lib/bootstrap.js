/**
 * Runtime bootstrap for the executable.
 *
 * An MCP host does not always start a server with the Node its user browses with. Some hosts pick
 * the first `node` they find on `PATH`, and on a machine with several nvm installs that can be an
 * ancient one — older than the syntax a dependency uses. The failure is then a `SyntaxError` from
 * inside `node_modules`, before this package can explain anything. So `bin/browser-use-mcp.mjs` is
 * a shim: if the current runtime is outside `package.json`'s engines, it finds a supported `node`
 * next to it and re-execs the same entry point with that one.
 *
 * This module is imported *before* the version check, so it has to stay parseable by old Node: no
 * `??=`, no class fields, no top-level await, and bare builtin specifiers (`fs`, not `node:fs`).
 * Everything else in the package may use modern syntax.
 *
 * @module browser-use-mcp/bootstrap
 */

import { spawn, spawnSync } from 'child_process'
import { existsSync, readdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'

/** The engine range, kept in step with `package.json`. */
export const REQUIRED_NODE = '^22.19.0 || >=24.0.0'

/**
 * Whether a version string (with or without a leading `v`) satisfies the engine range.
 * Node 23 is deliberately excluded: `^22.19.0 || >=24.0.0` excludes odd, non-LTS releases.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function isSupportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 22) return minor >= 19
  return major >= 24
}

/** Numeric parts of a version-shaped directory name, for sorting. */
function versionParts(name) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(name)
  if (!match) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Newest first, so a version-manager tree yields its best candidate before older ones. */
function compareVersionsDescending(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index]
  }
  return 0
}

/** `realpathSync` when the path exists, the literal path otherwise. */
function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch (error) {
    return path
  }
}

/**
 * Every `node` worth probing, in the order a user would expect: `PATH` first, then the version
 * managers' private trees (which a GUI client's short `PATH` often omits), then the usual install
 * locations. Candidates are deduplicated by real path; the caller skips the current executable.
 *
 * `options` exists for the tests: `{ env, platform, home }`.
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, home?: string}} [options]
 * @returns {string[]}
 */
export function candidateNodes(options) {
  const opts = options || {}
  const env = opts.env || process.env
  const platform = opts.platform || process.platform
  const home = opts.home || homedir()
  const list = []
  const seen = new Set()
  const nodeName = platform === 'win32' ? 'node.exe' : 'node'

  function add(path) {
    if (!path || !existsSync(path)) return
    const key = realpathOr(path)
    if (seen.has(key)) return
    seen.add(key)
    list.push(path)
  }

  function addVersionTree(root, suffix) {
    let entries
    try {
      entries = readdirSync(root)
    } catch (error) {
      return
    }
    entries.sort(compareVersionsDescending)
    for (const entry of entries) add(join(root, entry, suffix))
  }

  const pathValue = env.PATH || env.Path || env.path || ''
  for (const directory of pathValue.split(delimiter)) {
    if (directory) add(join(directory, nodeName))
  }

  if (platform === 'win32') {
    // nvm-windows keeps vX.Y.Z directories directly under %APPDATA%\nvm, or under %NVM_HOME%.
    if (env.APPDATA) addVersionTree(join(env.APPDATA, 'nvm'), 'node.exe')
    if (env.NVM_HOME) addVersionTree(env.NVM_HOME, 'node.exe')
    if (env.ProgramFiles) add(join(env.ProgramFiles, 'nodejs', 'node.exe'))
    if (env['ProgramFiles(x86)']) add(join(env['ProgramFiles(x86)'], 'nodejs', 'node.exe'))
    return list
  }

  const nvmDirectory = env.NVM_DIR || join(home, '.nvm')
  addVersionTree(join(nvmDirectory, 'versions', 'node'), 'bin/node')
  addVersionTree(join(home, '.local', 'share', 'fnm', 'node-versions'), 'installation/bin/node')
  addVersionTree(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), 'installation/bin/node')
  addVersionTree(join(home, '.local', 'share', 'mise', 'installs', 'node'), 'bin/node')
  addVersionTree(join(home, '.asdf', 'installs', 'nodejs'), 'bin/node')
  add(join(home, '.volta', 'bin', 'node'))

  add('/opt/homebrew/bin/node')
  add('/usr/local/bin/node')
  add('/usr/bin/node')

  return list
}

/** Ask one candidate for its version; `undefined` when it cannot answer. */
function probeNode(candidate) {
  let result
  try {
    result = spawnSync(candidate, ['-p', 'process.versions.node'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
  } catch (error) {
    return undefined
  }
  if (result.error || result.status !== 0) return undefined
  const version = String(result.stdout || '').trim()
  return version || undefined
}

/**
 * The first candidate that reports a supported version, skipping the executable already running.
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, home?: string, execPath?: string}} [options]
 * @returns {{path: string, version: string}|undefined}
 */
export function findSupportedNode(options) {
  const opts = options || {}
  const current = realpathOr(opts.execPath || process.execPath)
  for (const candidate of candidateNodes(opts)) {
    if (realpathOr(candidate) === current) continue
    const version = probeNode(candidate)
    if (isSupportedNode(version)) return { path: candidate, version }
  }
  return undefined
}

/** Print the actionable version error and exit. */
function failUnsupported(current, note) {
  const suffix = note ? ` (${note})` : ''
  process.stderr.write(
    `browser-use-mcp needs Node.js ${REQUIRED_NODE}, but this process is Node ${current}${suffix}.\n` +
      'Install a supported Node (for example `nvm install 22`) and start the server with it, or\n' +
      "point the MCP client's command at that node binary.\n",
  )
  process.exit(1)
}

/**
 * If the current runtime is too old, restart the entry point on a supported Node.
 *
 * Returns `false` when the caller should load and run the CLI in this process, `true` when a
 * supported child was started (the parent forwards signals and exits with the child). On no
 * supported Node it prints a real explanation and exits instead of letting a dependency fail with
 * a `SyntaxError`.
 *
 * `options` is `{ script, args, currentVersion, env, platform, home, execPath }`; the extra fields
 * exist so the behavior can be tested without owning the machine's Node installations.
 *
 * @param {{script?: string, args?: string[], currentVersion?: string, env?: NodeJS.ProcessEnv,
 *          platform?: string, home?: string, execPath?: string}} [options]
 * @returns {boolean}
 */
export function relaunchIfNeeded(options) {
  const opts = options || {}
  const current = opts.currentVersion || process.versions.node
  if (isSupportedNode(current)) return false

  if (process.env.BROWSER_USE_MCP_NODE_BOOTSTRAP === '1') {
    failUnsupported(current, 'it was already restarted once')
    return true
  }

  const found = findSupportedNode(opts)
  if (!found) {
    failUnsupported(current)
    return true
  }

  const script = opts.script || process.argv[1]
  const args = opts.args || process.argv.slice(2)
  process.stderr.write(
    `browser-use-mcp: Node ${current} is outside ${REQUIRED_NODE}; restarting with ${found.version} (${found.path})\n`,
  )

  const environment = Object.assign({}, process.env, { BROWSER_USE_MCP_NODE_BOOTSTRAP: '1' })
  const child = spawn(found.path, [script].concat(args), {
    stdio: 'inherit',
    env: environment,
  })

  function forward(signal) {
    try {
      child.kill(signal)
    } catch (error) {
      // The child is already gone; the exit handler below decides the parent's status.
    }
  }

  process.on('SIGINT', function onSigint() {
    forward('SIGINT')
  })
  process.on('SIGTERM', function onSigterm() {
    forward('SIGTERM')
  })
  try {
    process.on('SIGHUP', function onSighup() {
      forward('SIGHUP')
    })
  } catch (error) {
    // Not every platform knows SIGHUP; the other two cover an MCP host's shutdown.
  }

  child.on('error', function onError(error) {
    process.stderr.write(`browser-use-mcp: could not restart with ${found.path}: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', function onExit(code, signal) {
    process.exit(signal ? 1 : code === null ? 1 : code)
  })

  return true
}
