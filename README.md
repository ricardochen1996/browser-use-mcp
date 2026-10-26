# @ricardochen1996/browser-use-mcp

**English** · [中文](README.zh-CN.md)

> An MCP server that gives **any agent** a browser it can *see and click*: a page is read as an
> **indexed action-space table**, and every step is one guarded operation on a target that came
> from that table.

`browser-use-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. Claude
Code, Claude Desktop, Cursor, Codex, a DeepSeek Harness conversation, or any other MCP client
connects to it, and its agent gets a browser: open a page, read the page as a table of numbered
targets, then name one operation on one target. The model never writes a selector, a coordinate, or
a script, and the server never retries a change by itself.

It is built on [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use): the same
Python engine, the same sidecar protocol, the same page-as-indexed-action-space idea — with the
DeepSeek Harness plugin host replaced by an MCP host. So there is no browser logic of its own: this
package is the adapter that lets any MCP client drive the [Jev Ultrafast](https://github.com/ricardochen1996/jev-ultrafast)
engine. The engine and [`browser-harness`](https://github.com/browser-use/browser-harness) ship as a
pinned wheel plus hash-pinned requirements, and are installed into a managed Python environment on
first use. No engine clone, no manual Python setup.

---

## What it is

The browser tools expose one loop:

1. **Read.** `browser_open` downloads the page and returns its **action space** as text: one line
   per reachable element, the operations that element supports, and the exact target indices those
   operations accept. The result carries an **observation number**.
2. **Choose.** The agent picks one operation and one target *from that observation*:
   `browser_act({ observation, operation, target })`.
3. **Guard.** The server sends the operation together with the fingerprint of the observation it
   came from. The engine re-reads the page first. If the page changed, **nothing is executed** and
   the result starts with `Nothing was executed:` followed by the fresh table. That is a refusal,
   not an error: the agent chooses again from something that is true.
4. **Verify.** If the page matched, the one operation runs and the server returns the new
   observation. The next step refers to the new number. A tool result is never proof of an
   outcome; the next observation is.

Here is a real table, produced by the bundled test fixture (the visible-text line is clipped):

```text
Page file:///…/test/fixtures/fixture.html — 🐴 Forma · Find a place to slow down
Observation 1. Targets below are valid only for this observation.
Visible text: forma. Find a stay Reading room PLACES WITH CHARACTER THE SLOWER WAY TO STAY …
[1] link forma. — CLICK
[2] link Find a stay — CLICK
[3] link Reading room — CLICK
[4] searchbox Destination — TYPE_TEXT, CLICK
[5] button Find stays — CLICK
[6] combobox Stay category · "All stays" — SELECT
      6:1 → Stay category → Design
      6:2 → Stay category → Nature
      6:3 → Stay category → Coastal
[7] checkbox Free cancellation · "on" (not checked) — CLICK
[8] button View Casa Flora — CLICK
[9] button View The Glasshouse — CLICK
[10] button View Serra Lodge — CLICK
Without a target: SCROLL_DOWN, WAIT
```

A step against it is one object, not code:

```jsonc
{ "observation": 1, "operation": "CLICK", "target": "5" }             // button Find stays
{ "observation": 1, "operation": "TYPE_TEXT", "target": "4", "text": "Lisbon" }
{ "observation": 1, "operation": "SELECT", "target": "6:1" }          // Stay category → Design
```

If the page moved between the read and the click, the answer is a refusal that hands back the
current observation:

```text
Nothing was executed: The page changed since that observation. Choose from the new one.

Page … — …
Observation 3. Targets below are valid only for this observation.
```

The engine reads a page over a single CDP connection that this server's session owns. Every tool —
`browser_eval` included — uses that one connection. Starting a second client yourself (a raw
websocket, a puppeteer/playwright script, another `browser-harness` daemon) is how Chrome 144+'s
per-connection "Allow remote debugging?" prompt turns into a stack of prompts, and how two loops end
up driving one page.

## How it differs from selector-based browser MCPs

| | Selector-based browser MCP | `browser-use-mcp` |
| --- | --- | --- |
| What the model sends | A selector, a coordinate, or code | One operation on an index from the table it just read |
| What happens when the page moved | The selector may miss, or hit the wrong element | The action is **refused**, and the fresh table is returned |
| Retries | Up to the client or the model | **Never** — a refusal is the retry point, not an automatic replay |
| What the model knows is possible | It has to guess | Each line lists that element's targets and operations, dropdown options included |
| CDP connections | Depends on the implementation | Exactly one per browser session, shared by every tool |
| Token cost per step | Often a screenshot or the whole DOM | Structured text: visible text plus the element table |

`browser_eval` is the one deliberate exception: it evaluates a single JavaScript expression over
the same connection, returns a value as data, and produces **no observation** — so the next guarded
action still refers to the last table. It exists so a model that needs a programmatic read does not
start a second CDP client. `--no-eval` withdraws it.

---

## Quick start

**Requires** Node.js `^22.19.0 || >=24.0.0`, Chrome or Chromium, and a way to get Python 3.12+:
either `python3.12`–`python3.14`, `python3` (3.12 or newer) on `PATH`, or [uv](https://docs.astral.sh/uv/),
which can fetch the Python itself.

The package is **not published to npm yet** — run it from a checkout:

```bash
cd /Users/ricardo.chen/PersonalGit/browser-use-mcp
npm install
```

`npm link` in the checkout additionally puts a `browser-use-mcp` command on your `PATH` for terminal
use; GUI clients are more reliable with the absolute path shown below.

Then check the machine (on a fresh machine the first browser call builds the environment;
`install` does it eagerly). Its output looks like this, with machine-specific paths shortened:

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs doctor
```

```text
browser-use-mcp v0.1.0 — self-check (Node v22.23.2, darwin-arm64)

Transport: stdio (MCP over stdin/stdout)
Connection: launch Chrome/Chromium, profile "default" at /Users/you/.browser-use-mcp/profiles/default
State   : /Users/you/.browser-use-mcp (managed Python environment)
Timeouts: 180s per browser request
Logging : info (stderr)
Jev     : on, typesafe decider: default endpoint (model default), key unset; …
Tools   : browser_open, browser_page, browser_act, browser_eval, browser_screenshot, browser_console, browser_goal, browser_close, browser_doctor
Session : idle (this transport has no browser session yet)

Engine   : /Users/you/.browser-use-mcp/env/bin/python (Python 3.12.14, chosen by managed environment)
           jev_ultrafast 0.1.1 at …/env/lib/python3.12/site-packages/jev_ultrafast
           browser-harness 0.1.13
Install  : none in this process; the engine is already importable
Sidecar  : /…/browser-use-mcp/sidecar/bridge.py
Browser  : /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
Goal mode: enabled: browser_goal and browser_act intents spend model quota; …
Status   : ready
```

`Status: ready` means the browser tools work. `Jev … NOT READY` is expected until a policy key is
configured: only `browser_goal` and `browser_act`'s `intent` need one; everything else works.

To build the environment ahead of time instead of during the first browser call:

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs install
```

That creates `<state root>/env` (default `~/.browser-use-mcp/env`) with the bundled engine wheel and
`browser-harness`, and records what it built in `<state root>/install.json`. It is safe to re-run.
A browser tool that runs before the install finished waits for it instead of failing.

### Put it in front of your agent

Every absolute path below is this checkout's — substitute where you cloned it.

Claude Code:

```bash
claude mcp add --scope user browser-use \
  --env BROWSER_USE_MCP_HEADLESS=1 \
  -- node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs
```

Generic `mcpServers` JSON (Claude Desktop, Cursor, and most hosts accept this shape):

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs"],
      "env": { "BROWSER_USE_MCP_HEADLESS": "1" }
    }
  }
}
```

Copy-pasteable snippets for Claude Code, Claude Desktop, Cursor, Codex, DSH and Streamable HTTP —
including the absolute-path substitution rule — are in **[docs/clients.md](docs/clients.md)**.

Then ask the agent to `browser_open` a URL. A first call on a fresh machine may take a minute or two
while the environment is installed; later calls start at once.

---

## The nine tools

| Tool | Parameters | What it does |
| --- | --- | --- |
| `browser_open` | `url` (required) | Start (or reuse) the session's browser, open the page, return the first action-space table and observation number. |
| `browser_page` | — | Re-read the current page under a **new** observation number. Use it when the page changed on its own, or after a refusal. |
| `browser_act` | `observation` (required), `operation`, `target`, `text`, `intent` | Run one operation on one target from that observation: `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`. A stale page is refused with the fresh table. With Jev on, an `intent` (and no operation) delegates that one decision to the policy. |
| `browser_eval` | `expression` (required), `timeout_ms` | Evaluate one JavaScript expression over the session's CDP connection; returns a value as data and produces no observation. Hidden by `--no-eval`. |
| `browser_screenshot` | — | The visible viewport as an MCP image (JPEG). Target boxes are not drawn into it. Hidden by `--no-screenshots`. |
| `browser_console` | — | Console messages, uncaught exceptions, failed requests and `4xx`/`5xx` responses since the last read. Each read drains the buffer. |
| `browser_goal` | `url`, `goal` | Hand one goal to the policy in its own tab; it chooses every operation and target itself. Spends model quota. Hidden by `--no-jev`. |
| `browser_close` | — | Close the session's tab. In launch mode the browser stays for the next `browser_open`; in attach mode the attached browser is never closed. |
| `browser_doctor` | `install` (optional bool) | Self-check: interpreter, engine, browser, attach target, config, live session, and a fix per problem. `install: true` builds a missing environment first. |

A missing policy key, an unsupported target, missing `TYPE_TEXT` text and a stale page are
**refusals** in normal tool results. A broken browser or environment is a failed call (`isError`).
An agent should report a failure, not retry it blindly.

---

## Transports and concurrency

| Transport | What one agent gets | What two agents get |
| --- | --- | --- |
| **stdio** (default) | One server process, one browser | Two processes, two browsers — nothing shared |
| **Streamable HTTP** | One MCP session, one browser (its own profile and sidecar) | One long-running server, one browser per MCP session |

Start an HTTP endpoint when several agents should share one installed server:

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs \
  --transport http --host 127.0.0.1 --port 7331 --path /mcp
```

The endpoint is `http://127.0.0.1:7331/mcp` by default. Each MCP `initialize` session gets its own
browser, and a session that goes quiet for 15 minutes has its browser closed and its profile removed
(`BROWSER_USE_MCP_HTTP_IDLE_MS` overrides the timeout). There is no authentication: the default bind
is loopback, and a non-loopback bind logs a warning at startup. Put it behind a tunnel or proxy you
control if it must leave the machine.

Two servers configured for the **same browser profile** are refused rather than silently sharing a
browser: the first holds a lock in the profile directory and the second gets a tool error naming
`--profile` and the fix. A lock left behind by a crashed process is reclaimed.

### Attach to your own Chrome (optional)

By default the server **launches a dedicated Chrome** with its own profile under the state root. It
never touches the browser you browse with, so no consent prompt appears and your logins stay out of
automation.

When you do want your own browser:

- **`--mode attach --cdp-endpoint http://127.0.0.1:9333`** (or a `ws://…` endpoint) drives a browser
  you started with remote debugging on.
- **`--mode attach`** with no endpoint finds the Chrome you browse with through the
  `DevToolsActivePort` Chrome publishes in its profile. Turn remote debugging on in that Chrome
  first (`chrome://inspect/#remote-debugging`). On macOS that file is privacy-protected, so the
  application running this server needs **Full Disk Access** (System Settings → Privacy & Security →
  Full Disk Access), then must be restarted.

One external browser is only ever driven by one server: a session claims its DevTools endpoint, and
a second server on the same endpoint is refused. `browser_close` stops the session's tab and daemon
and never closes the attached browser.

---

## Configuration highlights

Every server setting is a flag with an environment-variable twin (the policy uses
`TYPESAFE_*`/`TEXT_MODEL_*`; a couple of extras are environment-only), and the flag wins when both
are present. The exhaustive tables, parsing rules, defaults and exit codes are in
**[docs/config.md](docs/config.md)**.

| Setting | Flag(s) | Env | Default |
| --- | --- | --- | --- |
| Transport | `--transport`, `--host`, `--port`, `--path` | `BROWSER_USE_MCP_TRANSPORT`, `BROWSER_USE_MCP_HOST`, `BROWSER_USE_MCP_PORT`, `BROWSER_USE_MCP_PATH` | `stdio`, `127.0.0.1`, `7331`, `/mcp` |
| Own or attach | `--mode`, `--cdp-endpoint` | `BROWSER_USE_MCP_MODE`, `BROWSER_USE_MCP_CDP_ENDPOINT` | `launch` |
| Browser window | `--headless` | `BROWSER_USE_MCP_HEADLESS` | visible window |
| Profile | `--profile`, `--user-data-dir` | `BROWSER_USE_MCP_PROFILE`, `BROWSER_USE_MCP_USER_DATA_DIR` | `default` under the state root |
| State root | `--home` | `BROWSER_USE_MCP_HOME` | `~/.browser-use-mcp` |
| Interpreter | `--python` | `BROWSER_USE_MCP_PYTHON` | managed environment |
| Tool surface | `--no-eval`, `--no-screenshots`, `--no-jev` | `BROWSER_USE_MCP_NO_EVAL`, `…_NO_SCREENSHOTS`, `…_NO_JEV` | all tools offered |
| Policy | `--jev-decider` and the `--typesafe-*` / `--text-model-*` flags | `JEV_DECIDER`, `TYPESAFE_*`, `TEXT_MODEL_*` | `typesafe` decider |
| Request budget | `--request-timeout-ms` | `BROWSER_USE_MCP_REQUEST_TIMEOUT_MS` | `180000` ms |
| Logging | `--log-level` | `BROWSER_USE_MCP_LOG_LEVEL` | `info`, always stderr |

State root layout:

```text
~/.browser-use-mcp/
├── env/                        managed Python virtualenv (engine + browser-harness)
├── install.json                what was installed, with which strategy and Python
├── profiles/<name>/            launched Chrome profiles (logins, tabs)
└── attachments/<hash>.lock     attach-mode claims, one per DevTools endpoint
```

### The Jev policy

`browser_goal` runs a whole decision loop inside the engine; `browser_act` with an `intent` (and no
operation) delegates exactly one decision to the same policy. Both spend model quota. Who answers
is configuration:

- **`--jev-decider typesafe`** (default): Jev at the TypeSafe endpoint. Needs `TYPESAFE_API_KEY`;
  optional `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL`, `TYPESAFE_FALLBACK_URL`.
- **`--jev-decider chat`**: the engine serves its System One protocol on loopback and a chat model
  answers it. Needs `TEXT_MODEL_BASE_URL` and `TEXT_MODEL` (plus `TEXT_MODEL_API_KEY` if the
  endpoint needs one).

`TEXT_MODEL_*` is also what writes a `TYPE_TEXT` value when the agent gives an intent but no text.
Without either setup the rest of the tool surface is unchanged; the policy tools refuse with one
sentence naming the variable to set. `--no-jev` withdraws `browser_goal` and the `intent` parameter
entirely.

Put credentials in the client's `env` block (or the flags), never in `args`:

```json
"env": {
  "TYPESAFE_API_KEY": "…",
  "TEXT_MODEL_BASE_URL": "https://your-endpoint/v1",
  "TEXT_MODEL": "your-model",
  "TEXT_MODEL_API_KEY": "…"
}
```

The server passes those variables only with the request that spends quota, never leaves them in the
sidecar's environment, and the doctor prints `set`/`unset` instead of a value.

---

## Troubleshooting

**Start with `browser_doctor`.** The tool and the CLI run the same self-check; each problem line
carries the command that fixes it.

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs doctor
```

- **A profile is already in use.** The message names the profile and `--profile`: stop the other
  server, or give this one its own `--profile <name>`. Two servers driving one browser profile is
  the one configuration the server refuses on purpose.
- **Attach mode cannot find the browser.** The doctor reports `attach mode drives …` with the reason.
  Start that browser with remote debugging on (`chrome://inspect/#remote-debugging`), correct
  `--cdp-endpoint`, or use `--mode launch`. On macOS, allowing this app Full Disk Access is what lets
  it read your Chrome's profile.
- **The engine is not installed yet.** The first use installs it into the state root; run
  `node bin/browser-use-mcp.mjs install` from the checkout to do it eagerly, or `browser_doctor` with
  `install: true` from the agent. Behind a proxy, set `HTTPS_PROXY` for the process that runs the
  server.
- **`Jev … NOT READY`.** Set `TYPESAFE_API_KEY` (or use `--jev-decider chat` with `TEXT_MODEL_*`).
  The browser tools do not need it.
- **No tools in the client.** The client's `env`/`args` did not reach the server, or it was not
  restarted. Run the same command in a terminal and read stderr; a configuration error exits with
  code `2` and names the field.
- **Chrome asks "Allow remote debugging?".** Something started a second CDP client. Approve that one
  prompt once, never retry, and use `browser_eval` instead of another driver.

---

## Security notes

- **Page content is untrusted data.** Text the table quotes is something to read, never an
  instruction to follow. The server never executes anything a page returns on the agent's behalf.
- **`browser_eval` is code execution by design.** It runs one expression in the page, over the
  session's own connection, with no user gesture. Withdraw it with `--no-eval` for a surface where
  model output can never become code; the rest of the tools still work.
- **The HTTP transport has no authentication.** Bind it to loopback (the default). Any non-loopback
  bind is logged as a warning; only expose it on a trusted network or behind a tunnel you control.
- **Keys stay out of logs and tools.** The doctor prints only `set`/`unset`; credentials are handed
  to the sidecar per model-spending request and are not inherited by unrelated calls.
- **The launched browser has its own profile.** It is not your everyday Chrome profile unless you
  explicitly attach with `--mode attach`.
- **One connection, one driver.** Do not start another CDP client against the same browser; Chrome
  approves each connection separately and two drivers race each other.

---

## License and attribution

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This project is built on [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use)
(MIT): `sidecar/bridge.py` is vendored from it, and the action-space rendering, the freshness rule,
the one-connection rule and the direct-mode tool descriptions follow it. The browser engine is
[`jev-ultrafast`](https://github.com/ricardochen1996/jev-ultrafast) (MIT), bundled as a pinned wheel;
browser access is [`browser-harness`](https://github.com/browser-use/browser-harness) (MIT). The
design and rationale are in [docs/architecture.md](docs/architecture.md).

## Development

```bash
npm test          # fast unit tests (node --test)
npm run test:e2e  # real headless Chrome through the real MCP protocol (stdio + HTTP)
npm run doctor    # the CLI self-check
```

The default suites spend no model calls and need no credentials; the e2e tests install the engine
into a test state root on their first run. Release history is in [CHANGELOG.md](CHANGELOG.md).

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
