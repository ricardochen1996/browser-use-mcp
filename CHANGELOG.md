# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-10-26

The first public version of `browser-use-mcp`: an MCP server that gives any agent a browser it can
see and click, built on the `dsh-browser-use` engine.

### Added

- **The action-space browser tools**, `dsh-browser-use`'s direct-mode surface over MCP:
  `browser_open`, `browser_page`, `browser_act`, `browser_eval`, `browser_screenshot`,
  `browser_console`, `browser_goal`, `browser_close`, `browser_doctor`. A page is rendered as one
  line per reachable element with its operations and exact target indices; every step is one
  operation on one target from the observation it names.
- **The freshness guard.** Each observation is recorded with its page fingerprint; `browser_act`
  sends the fingerprint with the operation, and a page that moved makes the engine execute nothing
  and answer with the fresh table. The server returns that as a normal tool result starting with
  `Nothing was executed:`. A mutation is never retried automatically, so there are no double clicks
  and no double submits.
- **One connection, one driver.** Every tool — `browser_eval` included — runs over the single CDP
  connection the session's sidecar owns. The server instructions and tool descriptions state the
  rule, because a model that needs a programmatic read must not start a second client (Chrome 144+
  asks "Allow remote debugging?" once per connection).
- **Two transports.** stdio (default; one server process = one browser) and Streamable HTTP
  (`--transport http --host --port --path`, default `http://127.0.0.1:7331/mcp`). Each MCP session
  on the HTTP endpoint gets its own browser, profile and sidecar; an idle session's browser is
  closed after 15 minutes (`BROWSER_USE_MCP_HTTP_IDLE_MS` overrides it) and its profile directory is
  removed. HTTP has no authentication; the default bind is loopback.
- **Two connection modes.** `launch` (default) starts a dedicated Chrome with its own profile under
  the state root; `attach` drives a running browser, either a configured
  `--cdp-endpoint` (`http(s)` or `ws(s)`) or the Chrome you browse with, discovered through
  `DevToolsActivePort`. `browser_close` never closes an attached browser.
- **Exclusive ownership.** A launched profile is claimed by one server at a time through a lock file
  in the profile directory; an attach-mode DevTools endpoint is claimed under
  `<state root>/attachments/`. A second live server is refused with a fix naming `--profile`; a lock
  left by a dead process is reclaimed.
- **Managed Python provisioning.** The package bundles `jev_ultrafast` 0.1.1 as a wheel and the
  sidecar's dependencies (`browser-harness` 0.1.13) as hash-pinned requirements. On first use it
  builds `<state root>/env` with `uv` when available, otherwise with a probed Python 3.12+ and
  `pip --require-hashes`; installs are serialized per state root by a lock directory with stale-lock
  reclaim, `install.json` records what was built, and `serve` prewarms the check in the background.
  `browser-use-mcp install` builds eagerly; `--python` hands the interpreter choice to the user and
  disables automatic installation.
- **`browser_doctor` and `browser-use-mcp doctor`.** The same look-only self-check from the agent
  and from a terminal: interpreter, engine and browser-harness versions, managed environment,
  browser to launch or attach target, resolved configuration, offered tools, live session, and a
  fix per problem. It never installs, opens a page, or prints a secret (`set`/`unset` only).
  `browser_doctor` with `install: true` is the explicit opt-in that builds a missing environment.
- **The Jev policy, optional and configurable.** `browser_goal` runs a whole decision loop in its own
  tab; `browser_act` with an `intent` and no operation delegates exactly one decision. The
  `typesafe` decider (default) uses `TYPESAFE_API_KEY`; the `chat` decider uses `TEXT_MODEL_*`.
  Policy variables travel only with the request that spends quota, a missing credential is a
  refusal naming the variable, and `--no-jev` withdraws `browser_goal` and `intent` entirely.
- **One resolved configuration.** Flags and environment are read in one place
  (`lib/config.js`): flag > environment > default, with strict validation, `~`/relative path
  handling, boolean and enum parsing, and a configuration error exit code of `2`.
- **Tool-surface switches.** `--no-eval`, `--no-screenshots` and `--no-jev` (with
  `BROWSER_USE_MCP_*` aliases) withdraw their tools without touching the rest of the surface.
- **Documentation.** `README.md`, `README.zh-CN.md`, `docs/clients.md` (Claude Code, Claude Desktop,
  Cursor, Codex, DSH and generic `mcpServers`, stdio and HTTP), `docs/config.md` (exhaustive flag
  and variable reference), `docs/architecture.md` (design and rationale), `AGENTS.md` (the working
  contract) and `NOTICE` (third-party attribution).
- **Tests.** `test/unit/` covers configuration, CLI parsing, rendering, sessions/locks and
  provisioning (including a real install into a temporary home); four real-browser end-to-end
  suites drive the real MCP protocol: `test/e2e/stdio.mjs` (tools, freshness guard, refusals,
  eval/screenshot/console, profile lock, tool switches), `test/e2e/http.mjs` (two MCP sessions on
  one endpoint never share a page, idle cleanup, a long profile name), `test/e2e/attach.mjs`
  (attach mode against a Chrome the test launches: the attached browser survives every close) and
  `test/e2e/intent.mjs` (the Jev intent/goal path against a loopback chat stub, plus the
  no-credentials refusal). No paid model calls and no credentials are needed.

### Fixed

These are the pre-release fixes that made the first version safe to publish.

- A stale page is a **normal tool result** carrying the fresh table, not an `isError`: the agent
  re-reads and chooses again instead of treating a moved page as a broken tool. A broken browser or
  environment, by contrast, is a failed call the agent should report rather than retry.
- Configuration is validated once, before anything starts: a bad enum, port, timeout, profile name
  or URL ends the process with code `2` and names the field, instead of failing later inside a tool
  call.
- The doctor only looks: `inspectEngine` never installs, `browser-use-mcp install` is the separate
  command, and `browser_doctor` requires `install: true` to build. A read-only self-check is what a
  person or an agent can safely run at any time.
- Jev credentials are copied into the one model-spending sidecar request and are not left in the
  server's or the sidecar's environment, so a stale key cannot leak into an unrelated call.
- Install concurrency is safe across processes: a lock directory records its owner, one install runs
  at a time per state root, and a lock whose pid is gone is reclaimed instead of blocking forever.
- Profile and attach locks behave the same way: a live holder refuses the second server with a
  message and a fix, a dead holder does not.
- The sidecar is never silently reused after a failed shutdown: the next browser is a new
  generation, and the caller is told what happened.
- A missing sidecar, engine or browser is reported as a problem with a runnable fix rather than a
  hang or a stack trace; tool failures are returned as tool results, never as transport failures.
- `browser_eval` reports a thrown expression and an unreturnable value as readable text instead of
  failing the call, and its request deadline covers the expression's own bound.
- The absolute path of `sidecar/bridge.py`, the bundled wheel and the requirements file is resolved
  from the package, not from the working directory, so a client may start the server from anywhere.
- `browser_goal` no longer fails in milliseconds: an unbounded request means no deadline timer at
  all, instead of a delay Node clamps to 1 ms. A goal run is bounded by the MCP client's timeout,
  and the engine stops it at `DONE`/`BLOCKED`.
- A long `--profile` name can no longer overflow the engine daemon's AF_UNIX socket path: the
  daemon name falls back to a stable short digest, and a runtime directory that cannot fit is
  refused with the variable that fixes it.
- An unexpected sidecar exit marks its generation unusable instead of silently reusing it, and a
  session that replaces a dead generation forgets that generation's page table.
- An HTTP MCP session is not closed by the idle sweep while a tool call is in flight, and a client's
  long-lived GET event stream does not keep it from ever looking idle.
- `browser_close` with no page open answers "nothing to close" instead of starting a browser.
- Numeric tool arguments (a target index that arrives as a JSON number) are accepted where a string
  is meant, instead of failing MCP input validation.

### Notes

- **Not published to npm yet.** Run it from a checkout: `npm install`, then
  `node /absolute/path/to/browser-use-mcp/bin/browser-use-mcp.mjs`. There is no `npx` installation
  to document until a release exists; `npm link` puts a `browser-use-mcp` command on `PATH` for
  terminal use.
- **Requirements:** Node.js `^22.19.0 || >=24.0.0`, Chrome or Chromium, and either a Python 3.12+
  (`python3.12`–`python3.14` or `python3`) or `uv` to build the managed environment.
- **The Jev key is optional.** Without it, `browser_goal` and `browser_act` intents refuse with one
  sentence naming the variable; everything else works. The default test suites never call a model.
- **State root:** `${BROWSER_USE_MCP_HOME:-~/.browser-use-mcp}` holds `env/`, `install.json`,
  `profiles/<name>/` and `attachments/`.
- This checkout was developed and verified on macOS with Node 22 and Chrome. `lib/python.js`
  carries macOS, Linux and Windows branches for interpreter and browser discovery; the end-to-end
  suites require a locally installed Chrome.
- `browser-use-mcp` is MIT licensed and bundles or vendors MIT work from `dsh-browser-use`,
  `jev-ultrafast` and `browser-harness`; see [NOTICE](NOTICE).

[Unreleased]: https://github.com/ricardochen1996/browser-use-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ricardochen1996/browser-use-mcp/releases/tag/v0.1.0
