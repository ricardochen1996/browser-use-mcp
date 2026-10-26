# AGENTS.md — working contract for `browser-use-mcp`

`browser-use-mcp` is an MCP (Model Context Protocol) server that gives **any** agent a browser it
can see and click. It is built on the [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use)
project: the same engine (`jev_ultrafast`), the same page-as-indexed-action-space idea, and the same
sidecar protocol — with the DeepSeek Harness plugin host replaced by an MCP host.

A page is read as a table of observed elements. The agent never sends a selector or a coordinate: it
sends an operation and a target index from the observation it just read. A page that moved refuses
the action instead of clicking blind. `browser_goal` / `browser_act`'s `intent` hand a decision to
the Jev policy, when credentials are configured.

## Repository layout

```text
bin/browser-use-mcp.mjs   CLI entry: `serve` (default), `doctor`, `install`
lib/config.js             flags + environment -> one resolved config object
lib/cli.js                argv -> { command, flags } (node:util parseArgs)
lib/log.js                stderr logger (stdout belongs to the stdio transport)
lib/jev.js               Jev/model environment resolution and readiness (never prints a key)
lib/python.js             find a Python 3.12+, create the managed virtualenv
lib/provision.js          install browser-harness + the bundled engine wheel into it
lib/engine.js             probe/ensure/install report, browser discovery, attach check
lib/sidecar.js            one sidecar process: line-JSON request/answer, stop, generations
lib/session.js            one browser session: observation numbers, fingerprints, queue
lib/render.js             observation -> the model-visible action-space table
lib/tools.js              MCP tools mapped onto the session
lib/server.js             McpServer assembly + stdio/HTTP transports + lifecycle
lib/doctor.js             doctor report used by the tool and the CLI
lib/http.js               Streamable HTTP transport (per MCP session browser isolation)
sidecar/bridge.py         VENDORED from dsh-browser-use; do not edit
vendor/                   bundled engine wheel + hash-pinned requirements
test/unit/*.test.mjs      fast unit tests (node --test)
test/e2e/*.mjs            real headless Chrome through the real MCP protocol
```

## The sidecar protocol (host side)

`sidecar/bridge.py` is spawned as a child process (interpreter comes from `lib/engine.js`) and
speaks one JSON object per line over stdin/stdout:

```jsonc
{"id": 1, "method": "open", "params": {"url": "https://example.com", ...connection}}
{"id": 1, "result": {"page": {...}}}
{"id": 2, "method": "act", "params": {"operation": "CLICK", "target": "2", "fingerprint": "..."}}
{"id": 2, "error": {"kind": "stale", "message": "...", "page": {...}}}
```

Methods: `hello`, `open`, `observe`, `evaluate`, `act`, `screenshot`, `diagnostics`, `goal`,
`close`, `shutdown`. Any request that may have to start a browser also carries the connection
parameters: `mode`, `cdpEndpoint`, `executablePath`, `userDataDir`, `headless`, `port`. Requests are
answered in order; the host never retries a browser mutation.

`page` is the observation object: `url`, `title`, `text`, `scroll`, `fingerprint`, `elements`,
`operations`, `labels`. The host renders it as text with `lib/render.js` and stores
`observation -> fingerprint`.

## The MCP tool contract

Names and parameters are fixed; descriptions are adapted from `dsh-browser-use`'s direct mode.
`browser_screenshot` returns MCP `image` content; every other tool returns text.

| Tool | Parameters | Notes |
| --- | --- | --- |
| `browser_open` | `url` (required) | Starts/reuses the session's browser, returns the action-space table and observation number. |
| `browser_page` | — | Re-read the page, new observation number. |
| `browser_act` | `observation` (required), `operation`, `target`, `text`, `intent` | One guarded operation; stale page → refusal text plus the fresh table. |
| `browser_eval` | `expression` (required), `timeout_ms` | One JS expression over the same CDP connection; no observation is produced. Hidden by `--no-eval`. |
| `browser_screenshot` | — | Visible viewport as an MCP image. Hidden by `--no-screenshots`. |
| `browser_console` | — | Console entries, exceptions, failed/4xx+ requests (drained per call). |
| `browser_goal` | `url`, `goal` | One policy run in its own tab; spends model quota. Hidden by `--no-jev`. |
| `browser_close` | — | Closes the owned tab; the launched browser stays for the next page. |
| `browser_doctor` | — | Self-check: interpreter, engine, browser, attach target, config, live session. |

Errors are returned as tool results (`isError: true` or explanatory text), never as transport
failures: a failed MCP call is what sends an agent looking for another client.

## Configuration surface (authoritative: `lib/config.js`)

Flags on `browser-use-mcp serve`, each mirrored by a `BROWSER_USE_MCP_*` environment variable:

```text
--transport stdio|http     --host --port --path
--mode launch|attach       --cdp-endpoint --executable --profile --user-data-dir --headless
--python PATH              --home DIR
--no-eval --no-screenshots --no-jev
--jev-decider typesafe|chat
--typesafe-base-url --typesafe-model --typesafe-api-key
--text-model-base-url --text-model --text-model-api-key --text-model-reasoning
--request-timeout-ms N     --log-level silent|error|info|debug
```

Jev also reads the engine's own variables, which an MCP client's `env` block can set:
`TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL`, `TYPESAFE_FALLBACK_URL`,
`TEXT_MODEL_API_KEY`, `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, `TEXT_MODEL_REASONING`,
`TEXT_MODEL_HEADERS`, `JEV_DECIDER`.

State root: `${BROWSER_USE_MCP_HOME:-~/.browser-use-mcp}` with `env/` (managed virtualenv),
`profiles/<profile>/` (launched Chrome profiles), `install.json` (provisioning record).

## Module contracts (cross-module interfaces are load-bearing)

### `lib/config.js`

```js
resolveConfig({ command, flags, env, cwd }) -> config   // throws ConfigError on a bad value
describeConfig(config) -> string[]                      // doctor lines, never a secret
config = {
  command: 'serve'|'doctor'|'install',
  transport: 'stdio'|'http', host, port, path,
  mode, cdpEndpoint, executablePath, userDataDir, headless, profile,
  browserUseMcpHome, pythonPath,
  allowEval, allowScreenshots, jev: {enabled, decider, typesafe:{...}, textModel:{...}},
  requestTimeoutMs, httpIdleMs, logLevel,
}
```

### `lib/python.js` (provisioner)

```js
findUv(env) -> string|undefined
environmentPython(envDir) -> string
// ordered: configured pythonPath first, then uv, then python3.12..3.14, then python3 if >= 3.12
basePythons(config) -> [{command, prefix, source}]
probePython(command, prefix) -> {version, major, minor}|{failure}
createEnvironment({config, envDir, onOutput}) -> {ok, python, strategy:'uv'|'python'}|{ok:false, code, error, fix}
```

### `lib/provision.js` (provisioner)

```js
stateRoot(config) -> string
ownEnvironment(config) -> string                     // <stateRoot>/env
installStatus() -> status|undefined                  // in-memory {state, step, startedAt, ...}
installEngine(config, {force, onOutput}) -> {ok, environment, strategy, pythonVersion, error?, code?, fix?, command?}
environmentRecord(envDir) -> record|undefined        // install.json
installHint(config) -> string                        // the command that installs now
duration(ms) -> '42s'
```

Install order: create the virtualenv (uv if present, else `<python> -m venv`), then
`uv pip install --python <env> -r vendor/requirements.txt` + the wheel, or pip with
`--require-hashes --no-deps --only-binary=:all:` and `--no-deps <wheel>`. One install at a time per
process and per state root (a lock directory; stale locks by dead pid are reclaimed). Write
`install.json` on success.

### `lib/engine.js` (provisioner)

```js
PACKAGE_ROOT, SIDECAR                            // absolute paths
probe(interpreter) -> {report}|{failure}
inspectEngine(config, {fresh}) -> report         // no install; problems carry a fix
ensureEngine(config, {fresh, install, onInstall, onOutput}) -> report
resolveInterpreter(config) -> interpreter
findBrowser(config) -> string|undefined
inspectAttach(config, interpreter) -> {target, checked, reachable, detail, code?, message?, fix?}
reportText(report, extra) -> string
forgetEngine()
report = {ok, sidecar, interpreter:{command,prefix,cwd,source}, attempts, problems:[{code,message,fix}],
          engine?:{python, engine, enginePath, browserHarness}, install?, browser?, attach?, goalMode?}
```

`inspectEngine` never installs; `ensureEngine` installs only when the managed environment is the
one in use (no `--python`, no external project) and the probe fails. `report.problems[].fix` is a
command a person can run.

### `lib/sidecar.js`, `lib/session.js`, `lib/render.js`, `lib/tools.js`, `lib/server.js`

Owned by the Lead; the exact shapes are in the source and in `docs/architecture.md`. Notable rules:

- One sidecar per browser session; a sidecar that cannot shut down cleanly is never reused (a new
  *generation* is started with a new daemon name).
- `session.run(operation)` serializes operations; each call gets its own cancellation signal.
- `session.fingerprintFor(observation)` returns the fingerprint of a known observation, or
  `undefined` for an observation this session did not produce.
- A `stale` sidecar error carries the fresh page: turn it into a refusal with the new table.

## Ownership while several agents work in this tree

| Owner | Files |
| --- | --- |
| Lead | `package.json`, `bin/`, `lib/config.js`, `lib/cli.js`, `lib/log.js`, `lib/sidecar.js`, `lib/session.js`, `lib/render.js`, `lib/tools.js`, `lib/server.js`, `lib/doctor.js`, `lib/http.js`, `test/e2e/`, `AGENTS.md`, `docs/architecture.md` |
| provisioner | `lib/python.js`, `lib/provision.js`, `lib/engine.js`, `test/unit/provision.test.mjs` |
| docs | `README.md`, `README.zh-CN.md`, `docs/clients.md`, `docs/config.md`, `CHANGELOG.md` |
| verifier | `test/e2e/`, `test/unit/` (review + independent checks; coordinate with the Lead) |

Do not edit files outside your scope. Edit with the `edit`/`write` tools (not shell heredocs) so
concurrent editors see each other's changes. `sidecar/bridge.py` is vendored: never edit it.

## Quality bar

- No model calls in the default test suite: a rendered page only. A chat-decider test may spin a
  local stub HTTP model on loopback (see `dsh-browser-use/test/check_bridge.py`).
- Every browser operation must be verified **on the page** (a later observation), not by trusting
  the action's own return value.
- Docs: English and Chinese (`README.zh-CN.md`), client snippets must be copy-pasteable for Claude
  Code/Desktop, Cursor, Codex and DSH, plus a generic `mcpServers` JSON.
- Never print secrets: doctor and logs show `set`/`unset`, never a key.
