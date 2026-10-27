# Configuration reference

Everything the server can be told, where it can be told it, and what wins when it is told twice.
The authoritative source is [`lib/config.js`](../lib/config.js) and [`lib/cli.js`](../lib/cli.js);
this page is the readable copy. If this page and the code ever disagree, the code is right and this
page is a bug.

`browser-use-mcp` has no configuration file. Settings arrive as command-line flags in the `args` a
client passes, as environment variables in the `env` block a client passes, or as defaults in code.
That is deliberate: an MCP client is already a configuration system, and one resolved config object
is what every other module reads.

## Precedence

**A flag wins over an environment variable, which wins over the built-in default.**

```text
flag  >  BROWSER_USE_MCP_* / Jev environment  >  default
```

A flag that is not passed is `undefined`, so it never shadows an environment variable. The three
one-way switches (`--no-eval`, `--no-screenshots`, `--no-jev`) can only withdraw a tool; their
positive environment aliases (`BROWSER_USE_MCP_EVAL=0`, …) say the same thing positively.

## Commands

```bash
browser-use-mcp [serve] [options]   # default: speak MCP on stdio, or Streamable HTTP
browser-use-mcp doctor  [options]   # look: interpreter, engine, browser, config, live session
browser-use-mcp install [options]   # build the managed Python environment now
browser-use-mcp --help | -h         # the flag list below
browser-use-mcp --version | -v      # the package version
```

| Command | What it does | Exit code |
| --- | --- | --- |
| `serve` (default) | Speaks MCP on stdio (default) or Streamable HTTP. Logs go to stderr because stdout is the protocol. | `0` after a clean shutdown; `1` on an unexpected error; `2` on a configuration error |
| `doctor` | Reports interpreter, engine versions, managed environment, browser / attach target, the resolved config, the tool list, the live session and a fix per problem. Never installs anything, never opens a page. | `0` when ready (`Status: ready`); `1` when it found a problem |
| `install` | Builds the managed environment eagerly. Safe to re-run: an environment whose interpreter still imports the engine is reused. | `0` when the engine is usable; `1` when the install failed |
| `--help`, `--version` | Print to stdout and exit. | `0` |

A configuration error (a bad enum, port, timeout, profile name, URL, boolean env value, or
`--mode launch` together with `--cdp-endpoint`) prints
`browser-use-mcp: configuration error: …` on stderr and exits with code `2`. The server never starts
in a half-valid state.

## Flags and environment variables

The column **Env** shows the variable that mirrors the flag. In an MCP client that passes an `env`
block, these are the names to use. `—` means there is no flag or no env spelling.

### Transport (Streamable HTTP)

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--transport` | `BROWSER_USE_MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `--host` | `BROWSER_USE_MCP_HOST` | `127.0.0.1` | HTTP bind address. Must not be empty. |
| `--port` | `BROWSER_USE_MCP_PORT` | `7331` | HTTP port, `1`–`65535`. |
| `--path` | `BROWSER_USE_MCP_PATH` | `/mcp` | HTTP route. A missing leading `/` is added; whitespace is refused. |
| — | `BROWSER_USE_MCP_HTTP_IDLE_MS` | `900000` (15 min) | HTTP only. Milliseconds of silence after which one MCP session's browser is closed and its profile directory removed. Resolved by `lib/config.js` (range 1000–86400000), used by the HTTP transport and reported by the doctor; there is no flag. |

### Browser connection

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--mode` | `BROWSER_USE_MCP_MODE` | `attach` | `attach` drives the browser that is already running (the default: the Chrome you use, or the one `--cdp-endpoint` names); `launch` starts a dedicated browser this server owns. `--mode launch` together with a CDP endpoint is refused rather than silently ignoring one of them. |
| `--attach-sharing` | `BROWSER_USE_MCP_ATTACH_SHARING` | `shared` | Attach only. `shared` lets several MCP sessions — and several server processes — drive that one browser at once, each in its own tab and over its own CDP connection. `exclusive` claims the DevTools endpoint for one live holder and refuses the next with a fix. Resolved to `exclusive` in launch mode, which has nothing to share; `shared` together with `--mode launch` is refused. |
| `--cdp-endpoint` | `BROWSER_USE_MCP_CDP_ENDPOINT` | unset | DevTools endpoint to attach to: an `http(s)` or `ws(s)` URL without whitespace. Setting it without `--mode` implies attach (attach is the default anyway). |
| `--executable` | `BROWSER_USE_MCP_EXECUTABLE_PATH` | discovered Chrome/Chromium | Browser executable to launch. A path that does not exist falls through to discovery. |
| `--profile` | `BROWSER_USE_MCP_PROFILE` | `default` | Profile name: `[A-Za-z0-9._-]{1,64}`, and not `.` or `..`. The directory is `<state root>/profiles/<profile>` unless `--user-data-dir` overrides it. Also the prefix of an HTTP session's profile label (`<profile>-<name>` when the client names one). |
| `--user-data-dir` | `BROWSER_USE_MCP_USER_DATA_DIR` | `<state root>/profiles/<profile>` | Launch this browser profile directory instead of the managed one. Not used by HTTP sessions, which always use `<state root>/profiles/…`: an anonymous session gets `<profile>-<session suffix>` (removed when it ends), a named one `<profile>-<name>` (kept). |
| `--headless` | `BROWSER_USE_MCP_HEADLESS` | `false` | Launch without a visible window. The env value accepts `1/true/yes/on` and `0/false/no/off`. |
| `--headed` | — | — | Explicit inverse of `--headless`; `--headless` wins if both are passed. |
| `--home` | `BROWSER_USE_MCP_HOME` | `~/.browser-use-mcp` | State root: managed environment, install record, browser profiles, attach locks. `~` expands; a relative path resolves against the working directory. |
| `--python` | `BROWSER_USE_MCP_PYTHON` | unset | Use exactly this Python 3.12+ interpreter, and do not install anything. See [Managed or explicit Python](#managed-or-explicit-python). |

### Tool surface

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--no-eval` | `BROWSER_USE_MCP_NO_EVAL=1`, or `BROWSER_USE_MCP_EVAL=0` | eval on | Withdraw `browser_eval`. |
| `--no-screenshots` | `BROWSER_USE_MCP_NO_SCREENSHOTS=1`, or `BROWSER_USE_MCP_SCREENSHOTS=0` | screenshots on | Withdraw `browser_screenshot`. |
| `--no-jev` | `BROWSER_USE_MCP_NO_JEV=1`, or `BROWSER_USE_MCP_JEV=off` (also `false`, `0`, `no`) | Jev on | Withdraw `browser_goal` and `browser_act`'s `intent` parameter. The rest of the surface works identically. |

### Jev policy

The policy variables use the engine's own names (`TYPESAFE_*`, `TEXT_MODEL_*`), not the
`BROWSER_USE_MCP_*` prefix, because that is the convention an MCP client's `env` block already
uses for model credentials. The server copies them into the one sidecar request that spends model
quota; they are never left in the server's environment or the sidecar's.

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--jev-decider` | `JEV_DECIDER` | `typesafe` | `typesafe`: Jev answers the policy questions. `chat`: a text model answers them through the engine's loopback System One endpoint. |
| `--typesafe-base-url` | `TYPESAFE_BASE_URL` | engine default | TypeSafe endpoint. |
| `--typesafe-model` | `TYPESAFE_MODEL` | engine default | TypeSafe model name. |
| `--typesafe-api-key` | `TYPESAFE_API_KEY` | unset | TypeSafe key. **Required** for `--jev-decider typesafe`. |
| — | `TYPESAFE_FALLBACK_URL` | unset | Env only; forwarded to the engine as a fallback endpoint. |
| `--text-model-base-url` | `TEXT_MODEL_BASE_URL` | unset | OpenAI-compatible chat endpoint. |
| `--text-model` | `TEXT_MODEL` | unset | Text model name. |
| `--text-model-api-key` | `TEXT_MODEL_API_KEY` | unset | Text model key, when the endpoint needs one. |
| `--text-model-reasoning` | `TEXT_MODEL_REASONING` | `thinking-disabled` | Reasoning mode as the engine should set it: `none` or `thinking-disabled` (an empty value means "leave it to the engine"). |
| — | `TEXT_MODEL_HEADERS` | `{}` | Env only. Extra HTTP headers for the text model, as a JSON object of string values, e.g. `{"X-Org":"team-a"}`. |

With `--jev-decider chat`, the engine serves its System One protocol on loopback and the text model
answers it; `TYPESAFE_*` values are deliberately not sent so a stale key cannot win.
`TEXT_MODEL_*` is also what writes a `TYPE_TEXT` value when the agent gives an intent but no text,
including with the `typesafe` decider.

### Timeouts and logging

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--request-timeout-ms` | `BROWSER_USE_MCP_REQUEST_TIMEOUT_MS` | `180000` | Longest single browser request, `1000`–`3600000` ms. `browser_eval` gets at least 125 s; `browser_goal` is deliberately not bounded by it, because a goal run decides its own length. |
| `--log-level` | `BROWSER_USE_MCP_LOG_LEVEL` | `info` | `silent`, `error`, `info`, `debug`. Every log line goes to **stderr**; stdout belongs to the stdio transport. |

## Parsing rules

These are the rules `lib/config.js` applies to both spellings, so a flag and its env variable can
never mean two different things:

- **Booleans** (`BROWSER_USE_MCP_HEADLESS`, the positive tool-surface aliases): `1`, `true`, `yes`,
  `on` are true; `0`, `false`, `no`, `off` are false; anything else is a configuration error.
- **Integers** (`port`, `request-timeout-ms`): whole numbers only, range-checked as above.
- **Enums** (`transport`, `mode`, `jev-decider`, `log-level`, `text-model-reasoning`): matched
  case-insensitively; an unknown value is an error listing the accepted set.
- **URLs** (`cdp-endpoint`, TypeSafe and text-model URLs): an absolute `http(s)` or `ws(s)` URL
  without whitespace; an empty string means "unset".
- **Paths** (`--home`, `--user-data-dir`, `--executable`, `--python`): `~` and `~/…` expand to the
  home directory, and a relative path resolves against the process's working directory at startup.
- **Profile names**: `[A-Za-z0-9._-]{1,64}`, not `.` or `..` — a profile name becomes a directory
  name under the state root.
- **`TEXT_MODEL_HEADERS`**: must parse as a JSON object whose values are strings.

## State root

`--home` / `BROWSER_USE_MCP_HOME` names one directory. Default: `~/.browser-use-mcp`.

```text
~/.browser-use-mcp/
├── env/                        managed Python 3.12 virtualenv: jev_ultrafast + browser-harness
├── install.json                what was installed, with which strategy and Python version
├── install.lock/               transient cross-process install lock (owner pid inside)
├── profiles/<name>/            launched Chrome profiles; logins and tabs live here
│   └── .browser-use-mcp.lock   held while a server drives this profile
└── attachments/<hash>.lock     one attach-mode claim per DevTools endpoint
```

Only reading a report creates nothing; the directories appear when an install, a launch or an
attach first needs them.

## The Jev policy, exactly

`browser_goal` and `browser_act`'s `intent` spend model quota. Before the engine is asked, the tool
checks that a model call could actually run and refuses with one sentence naming what to set:

| Decider | Required | Optional |
| --- | --- | --- |
| `typesafe` (default) | `TYPESAFE_API_KEY` | `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL`, `TYPESAFE_FALLBACK_URL`, and the whole `TEXT_MODEL_*` group for generated `TYPE_TEXT` values |
| `chat` | `TEXT_MODEL_BASE_URL` and `TEXT_MODEL` | `TEXT_MODEL_API_KEY`, `TEXT_MODEL_REASONING`, `TEXT_MODEL_HEADERS` |

Notes:

- `--no-jev` removes the policy surface entirely: no `browser_goal`, and `browser_act` has no
  `intent` parameter. Everything else works the same.
- Missing credentials are a **refusal in a normal tool result**, not a failed call: the text names
  the variable to set. The doctor adds `Jev: … — NOT READY: …` and reports keys only as
  `set`/`unset`.
- `browser_goal` also needs `TEXT_MODEL_*` only when the policy has to generate a typed value; a
  goal made of clicks does not need the text model.

## Managed or explicit Python

The engine is a Python package, so the server needs a Python 3.12+ interpreter that can import
`jev_ultrafast` and `browser_harness`.

**Managed (default).** With no `--python`, the server owns `<state root>/env`:

- It is probed first. When it exists and imports both packages, it is used.
- When it does not exist, `serve` prewarms the check in the background and a browser call (or the
  doctor's fix) waits for it; `browser-use-mcp install` builds it eagerly.
- The install looks for a builder in this order: `uv` (which can also fetch a pinned Python 3.12),
  then `python3.14`, `python3.13`, `python3.12`, `python3` on `PATH` (`python.exe` on Windows) —
  each probed, and each must be 3.12 or newer.
- `uv` builds the virtualenv and installs `vendor/requirements.txt` plus the bundled wheel with
  `uv pip`; without `uv`, `pip` is called with `--require-hashes --no-deps --only-binary=:all:`
  and the same wheel. One install at a time, per state root, via `install.lock/`; a lock left by a
  dead process is reclaimed.
- `install.json` is written on success: strategy, environment path, Python version, install time,
  engine version, browser-harness version.
- If no managed environment exists but another Python on `PATH` already imports the engine, that
  interpreter is used; the server does not install when the engine is already importable.

**Explicit (`--python PATH`).** That interpreter is the only candidate: it is either usable or the
problem is reported. The server never installs into it and never falls back to another Python. This
is the option for a development environment where the engine is already installed.

## Launch and attach

**Attach** (default). The server drives a browser that is already running — normally the Chrome you
browse with, found through the `DevToolsActivePort` file Chrome publishes in its profile. Turn
remote debugging on in that Chrome first (`chrome://inspect/#remote-debugging`). On macOS that file
is privacy-protected, so the application running this server needs **Full Disk Access** (System
Settings → Privacy & Security → Full Disk Access), then be restarted. When the engine cannot read
the profile, the doctor reports `no_permission` / `no_browser` with the fix rather than guessing.

**Attach with `--cdp-endpoint`.** The server drives a browser someone else started with remote
debugging on. An `http(s)` endpoint is asked for `/json/version` (the way the first browser call
asks); a `ws(s)` endpoint is only asked whether something is listening.

**Sharing an attached browser.** `--attach-sharing shared` (default) is what makes one endpoint
usable by several MCP sessions at once: each session gets its own sidecar, its own daemon and its
own tab on that browser. Chrome 144+ asks "Allow remote debugging?" once per connection, so N live
sessions mean N prompts — approve each once and never retry an unanswered one. With
`--attach-sharing exclusive`, a claim lives at `<state root>/attachments/<hash>.lock` (keyed by the
DevTools endpoint) and the second live holder is refused with a fix. In shared mode no such lock is
taken, and two separate server processes may also drive the browser.

**Launch** (`--mode launch`). The server starts Chrome/Chromium with its own profile directory under
the state root. It never touches the browser you browse with, so no Chrome consent prompt appears
and your logins stay out of automation. Each profile is held by one server at a time: the lock file
is `<profile dir>/.browser-use-mcp.lock`, and a second server on the same profile gets a tool error
naming `--profile` with the fix. A lock left by a crashed process is reclaimed.

In attach mode `browser_close` closes the session's tab and daemon; the browser you attached to is
never closed. In launch mode the launched browser stays up for the next `browser_open` and is closed
when the MCP connection ends.

## Streamable HTTP details

- Default endpoint: `http://127.0.0.1:7331/mcp`. The host and path are configurable, the route is
  exact.
- Each MCP session (`initialize`) gets its own browser session: its own sidecar process, its own
  tab, and (in launch mode) its own profile.
- In launch mode a session can name its profile on the initialize request —
  `/mcp?profile=<name>` or header `X-Browser-Use-Profile: <name>`, 1–32 characters from
  `[A-Za-z0-9_-]` — and then the directory `<profile>-<name>` is kept when the session ends, so a
  reconnect with the same name keeps its logins. Different names run concurrently on different
  profiles; two live sessions with the same name are refused by the profile lock. An anonymous
  session gets `<profile>-<session suffix>` and the directory is removed when it ends. An invalid
  name is refused at initialize with `400`.
- A session that stays silent longer than `BROWSER_USE_MCP_HTTP_IDLE_MS` (15 minutes by default) has
  its tab and browser closed and its anonymous profile directory removed. An explicit session
  termination is cleaned up immediately. Named profiles are never removed by the server.
- Requests to another path get `404`; a known session id is required for follow-up requests; an
  unknown or expired one gets `404` with "send initialize again"; a `GET` without a session gets
  `400` with the same guidance. Plain JSON responses are enabled, and an SSE-capable client still
  gets its stream on `GET`.
- There is **no authentication**. The default bind is loopback; binding a non-loopback address logs
  a warning at startup. Put it behind a tunnel or reverse proxy you control if it must leave the
  machine.
- `SIGINT`, `SIGTERM` and `SIGHUP` close every session's browser before the process exits.

## See also

- [Client wiring](clients.md) — copy-pasteable snippets for Claude Code, Claude Desktop, Cursor,
  Codex, DSH and plain `mcpServers` JSON.
- [Architecture](architecture.md) — how the pieces fit and why.
- [README](../README.md) — what the server is and how to use it.
- [CHANGELOG](../CHANGELOG.md) — what changed in each release.
