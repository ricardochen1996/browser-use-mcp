# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.4] - 2026-10-29

### Fixed

- **`browser_console` reports the failed/4xx requests of a page's own load.** The previous release
  enabled `Runtime` and `Network` only after the engine had navigated and settled. Chrome replays
  `Runtime` console messages and exceptions on enable, but it does not replay `Network` events, so
  the load's failed requests were still missing. The vendored sidecar now enables both domains the
  moment a tab is attached — before the engine navigates it — so a page's load is reported in full,
  and a tab a click opens is watched from its first byte. `Session._watch_diagnostics()` stays as
  the safety net for any session created another way.
- **A server killed with `SIGKILL` no longer leaks its Browser Harness daemon.** The daemon is
  deliberately detached, and the per-process daemon name means no later process can adopt one left
  by a killed server: it would hold a CDP connection forever, one leaked connection per hard kill.
  Every server start now reaps daemons whose owning process is gone (macOS and Linux, where the
  daemon IPC is a Unix socket; on Windows the daemon speaks TCP and reaping is left out). A daemon is
  signalled only after its own socket answers a ping with the pid it published, so a recycled pid can
  never turn cleanup into killing an unrelated process; a daemon whose owner is alive is never
  touched. The sidecar also shuts its own browser and daemon down when its host disappears without
  asking (end of input), so a SIGKILLed launch-mode server no longer leaks the Chrome it launched
  either.
- **The socket-path budget is now spent on the directory the engine actually binds.** Browser
  Harness resolves symlinks before it opens its socket, so a runtime directory reached through a
  link — `/tmp` on macOS is `/private/tmp` — was budgeted on the shorter spelling and could pass a
  path the engine then rejected with `fatal: AF_UNIX path too long`. The host resolves the deepest
  existing part of the path first, so a name is chosen (digest fallback included) against the same
  path the engine will use, and a genuinely too-long runtime directory gets the actionable
  `BH_RUNTIME_DIR` message instead of the engine's opaque fatal.

### Changed

- **A configured `--python` that runs an older engine now says so in `browser_open`.** The managed
  environment is still rebuilt automatically when its engine is not the one this package ships, but
  a caller-owned interpreter is only probed. Its warning, with the `uv pip install` fix, is now
  included in the note of a session's first `browser_open`, not only in `browser_doctor`.
- The vendored `sidecar/bridge.py` patch enables diagnostics at attach time; `NOTICE` records the
  new SHA-256 and `patches/README.md` describes the change. No engine or wheel change: the bundle
  is still `jev_ultrafast` 0.1.2.

## [0.1.3] - 2026-10-28

### Fixed

- **`browser_console` reports the page's console output.** It was always empty: the sidecar
  filtered the Browser Harness event buffer by the CDP session this run drives, but `Runtime` and
  `Network` had only been enabled on the session the daemon itself attached to. The sidecar now
  enables both domains on the run's own session — once per session, re-checked when a click
  follows a new tab — before the first observation. Console entries and exceptions, including the
  ones the page produced while it loaded (Chrome replays those on `Runtime.enable`), and every
  failed or 4xx+ request made while the session drives the tab are now reported; request failures
  from the initial load itself predate the enable and are not replayed by Chrome. Diagnostics stay
  best effort: a domain that cannot be enabled never fails the browser call it belongs to.
- **`browser_open` no longer fails a page that takes more than 5 s to load.** The engine navigated
  through Browser Harness's 5 s IPC default, which is sized for one CDP round trip, so a slow
  origin (a TLS handshake, a redirect chain, a cold profile) was reported as `Page.navigate timed
  out after 5s` while the browser was still loading it. `Page.navigate` now gets a page-load-scale
  timeout; the engine's existing settle loop still bounds the load, and every other call keeps the
  harness default.
- **All stdio server processes with the same profile shared one Browser Harness daemon.** Two
  servers drove one tab, and either shutdown made the other fail with `FileNotFoundError`. Each
  server process now gets its own daemon name; a request that still meets a vanished daemon is
  answered with `lost_session` and a call to `browser_open` instead of the raw Python error.

### Changed

- The bundled engine is `jev_ultrafast` 0.1.2 (was 0.1.1) and the vendored `sidecar/bridge.py`
  carries the two upstream fixes above. Both ship as patch files under `patches/`, with
  `patches/README.md` saying how to apply them to their upstream revisions; `NOTICE` records the
  revisions and SHA-256 hashes of what ships.
- **An upgrade rebuilds a managed environment an earlier release built.** Importing the engine was
  the only readiness question, so a machine that already had `~/.browser-use-mcp/env` kept the old
  engine and never received the page-load fix above. The probed engine version is now compared with
  the wheel this package carries; a mismatch rebuilds the managed environment on the next browser
  call (the first one after upgrading waits for that install once). A configured `--python` is left
  alone — that interpreter is the caller's to manage, so its engine version is their decision — but
  the doctor now warns about the mismatch and names the command that installs the bundled wheel
  there.

## [0.1.2] - 2026-10-28

Documentation only: the server behaves exactly as 0.1.1.

### Fixed

- **The install instructions match the published package.** `README.md`, `README.zh-CN.md` and
  `docs/clients.md` no longer say the package is unpublished or tell people to run a local
  checkout. They install `@ricardochen1996/browser-use-mcp` from npm — `npx -y
  @ricardochen1996/browser-use-mcp@latest`, or `npm install -g` for the `browser-use-mcp` command —
  and every client snippet (Claude Code, Claude Desktop, Cursor, Codex, DSH, generic `mcpServers`,
  Streamable HTTP) starts the published release. An absolute path now appears only as the fallback
  for a GUI client whose `PATH` cannot see `npx`/`browser-use-mcp`.
- Both READMEs' doctor samples show `v0.1.2` and the installed package's `sidecar/bridge.py` path.

## [0.1.1] - 2026-10-27

Release tooling and documentation only: the server behaves exactly as 0.1.0.

### Changed

- **npm Trusted Publishing.** A `vX.Y.Z` tag release now publishes through npm's OIDC trusted
  publishing when no `NPM_TOKEN` secret is configured: the package names this repository,
  `.github/workflows/release.yml` and the `npm` environment, so npm exchanges the job's short-lived
  OIDC token for publish access and generates provenance without a long-lived token. A repository
  that adds an `NPM_TOKEN` secret keeps working the old way.
- GitHub Actions runs the unit suite on Node 22.19 and 24 and every end-to-end suite as its own
  annotated step on Ubuntu (Chrome plus a managed Python 3.12 environment); a failing unit test is
  published as an annotation, so a red run is diagnosable from the run page without the job log.
- The release workflow fetches annotated tag objects explicitly (checkout can leave a lightweight
  ref), refuses to continue when the tag or version disagree, skips a version that is already on
  npm, and attaches the verified `dist/` tarball to the GitHub Release.
- README (English and Chinese) documents the trusted-publisher path and the tag workflow.

## [0.1.0] - 2026-10-27

The first public version of `browser-use-mcp`: an MCP server that gives any agent a browser it can
see and click, built on the `dsh-browser-use` engine.

### Added

- **Attach mode is the default.** Out of the box the server drives the Chrome you already use: turn
  remote debugging on once (`chrome://inspect/#remote-debugging`) and the agent sees your logins and
  tabs, with no new profile per run. `--mode launch` keeps the old behaviour of a dedicated browser
  with a profile under the state root (and is still what the e2e suites use).
  `--attach-sharing shared` (default) lets several sessions — and several server processes — drive
  that browser at once, each in its own tab; `exclusive` refuses a second live holder with a fix.
- **Named, persistent HTTP profiles.** In launch mode an HTTP client may name its profile on the
  initialize request (`/mcp?profile=<name>` or header `X-Browser-Use-Profile: <name>`): the
  directory `<state root>/profiles/<server profile>-<name>` is kept across reconnects, so logins
  survive; different names run concurrently on different profiles, and two live sessions with the
  same name are refused by the profile lock. Anonymous sessions keep the old behaviour (unique
  profile, removed when the session ends). Invalid names are refused at initialize.
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
- **CI and release automation.** GitHub Actions runs the unit suite on Node 22.19 and 24, the
  release gate (manifest, changelog and the exact packed file list must agree) and a real-browser
  end-to-end job on Ubuntu (Chrome plus a managed Python 3.12 environment). A `vX.Y.Z` annotated tag
  on `main` triggers the release workflow: it validates that the tag and `package.json` agree, reruns
  the full CI gate, publishes to npm with provenance, and creates the GitHub Release. Publishing is
  idempotent: an already-published version is skipped rather than failing the run.
- **Tests.** `test/unit/` covers configuration, CLI parsing, rendering, sessions/locks and
  provisioning (including a real install into a temporary home); five real-browser end-to-end
  suites drive the real protocol: `test/e2e/stdio.mjs` (tools, freshness guard, refusals,
  eval/screenshot/console, crash recovery, profile lock, tool switches), `test/e2e/http.mjs` (two
  MCP sessions on one endpoint never share a page, idle cleanup, a long profile name),
  `test/e2e/attach.mjs` (attach mode against a Chrome the test launches: the attached browser
  survives every close), `test/e2e/intent.mjs` (the Jev intent/goal path against a loopback chat
  stub, plus the no-credentials refusal) and `test/e2e/protocol.mjs` (hand-written JSON-RPC with no
  MCP SDK on the client side). No paid model calls and no credentials are needed.

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
- `browser-use-mcp install` succeeds when it built the engine, even in the default attach mode with
  no browser running: the attach target belongs to the doctor and the first browser call, so the
  installer no longer exits non-zero on a machine (or CI runner) where it did its job.
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
- A sidecar that dies unexpectedly no longer leaks its Browser Harness daemon: the crash handler
  reaps the generation's daemon (its socket and pid files included) because that generation is
  never reused. The stdio e2e now kills a sidecar mid-session and asserts both the fresh
  generation and the absence of the old daemon.

### Notes

- **Install:** `npx -y @ricardochen1996/browser-use-mcp@latest` (or
  `npm install -g @ricardochen1996/browser-use-mcp` for the `browser-use-mcp` command). Running a
  development checkout is covered in the README's "From source" section.
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

[Unreleased]: https://github.com/ricardochen1996/browser-use-mcp/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/ricardochen1996/browser-use-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/ricardochen1996/browser-use-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/ricardochen1996/browser-use-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/ricardochen1996/browser-use-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/ricardochen1996/browser-use-mcp/releases/tag/v0.1.0
