# Architecture

`browser-use-mcp` is an MCP server. An agent — Claude Code, Codex, Cursor, a DeepSeek Harness
conversation, or any other MCP client — connects to it, and the agent gets a browser it can see and
click. This document explains how the pieces fit, what travels on the wire, and why the design is
shaped the way it is.

It is built on [`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use): the same
Python engine, the same sidecar protocol, the same page-as-indexed-action-space idea, with the
DeepSeek Harness plugin host replaced by an MCP host.

## The shape

```text
┌──────────────────┐        MCP (stdio or Streamable HTTP)          ┌──────────────────────────────────┐
│  agent / client  │ ◄────────────────────────────────────────────► │  browser-use-mcp (Node)          │
│  (any MCP host)  │   tools/list, tools/call, content blocks       │  lib/server.js  lib/tools.js     │
└──────────────────┘                                                │  lib/session.js lib/http.js      │
                                                                    └──────────┬───────────────────────┘
                                                                               │ one JSON object per line
                                                                               │ over stdin/stdout
                                                                    ┌──────────▼───────────────────────┐
                                                                    │ sidecar/bridge.py (Python,       │
                                                                    │ vendored from dsh-browser-use)   │
                                                                    └──────────┬───────────────────────┘
                                                                               │ imports
                                                                    ┌──────────▼───────────────────────┐
                                                                    │ jev_ultrafast (bundled wheel)    │
                                                                    │ dynamic indexed action space,    │
                                                                    │ guards, executor                 │
                                                                    └──────────┬───────────────────────┘
                                                                               │ browser_harness
                                                                    ┌──────────▼───────────────────────┐
                                                                    │ Chrome / Chromium over CDP       │
                                                                    └──────────────────────────────────┘
```

Four processes at most: the agent, this MCP server, one Python sidecar per browser session, and the
browser. The sidecar is the only process that imports the engine; this server only speaks to it, and
the browser only ever sees the single CDP connection the sidecar's daemon owns.

## One step, end to end

1. The agent calls `browser_open` (or `browser_page`) and receives the page as text:

   ```text
   Page https://example.com/search — Example
   Observation 3. Targets below are valid only for this observation.
   Visible text: Find a place to slow down
   [1] textbox Destination · "Lisbon" — TYPE_TEXT
   [2] checkbox Free cancellation (partly checked) — CLICK
   [3] combobox Category — SELECT
         3:1 → Design
         3:2 → Wellness
   [4] button Find stays (collapsed) — CLICK
   Without a target: SCROLL_UP, SCROLL_DOWN, WAIT
   ```

2. The agent calls `browser_act({ observation: 3, operation: "CLICK", target: "4" })`. The target is
   an index into observation 3 — never a selector, a coordinate, or code.

3. This server looks up the fingerprint it recorded for observation 3 and sends
   `{operation, target, fingerprint}` to the sidecar.

4. The engine re-reads the page. If the fingerprint changed, it executes **nothing** and answers
   `{kind: "stale", page: <new observation>}`. This server turns that into a tool result that starts
   with `Nothing was executed:` and includes the fresh table — the agent chooses again from something
   that is true. No change is ever retried automatically, so there are no double clicks or double
   submits.

5. If the fingerprint matches, the engine executes the one operation, waits for the page to settle,
   and answers with the new observation. This server numbers it, records its fingerprint, and returns
   the new table. The agent's next step refers to the new number.

`browser_goal` is the same loop run to completion inside the engine: the policy picks every operation
and target itself until it reports `DONE` or `BLOCKED`. `browser_act` with an `intent` and no
operation delegates exactly one decision to the same policy.

## Why an action space instead of selectors

Playwright-style tools make the model write selectors. A selector can be wrong before it is used,
cannot be validated against the page it will run on, and fails silently when the page changes. Here
the model can only name something the server just observed, and the engine refuses a name whose
observation no longer matches. The trade is that every step needs an observation in the model's
context; the gain is that a model mistake is a refused index rather than a click on the wrong button.

`browser_eval` is the deliberate exception: one JavaScript expression, run over the same single CDP
connection, whose result is data and never a decision. It produces no observation, so the next
guarded action still refers to the last observation. It can be withdrawn with `--no-eval`.

## One connection, one driver

Chrome 144+ asks "Allow remote debugging?" once per CDP connection. Every client that connects is
another prompt, and an unanswered prompt is only kept alive by the client that raised it — retrying
drops the sheet and raises a new one. That is why nothing in this package starts a second client:
the sidecar's Browser Harness daemon is the only one. `browser_eval` runs through it too. The tool
descriptions and the server instructions repeat the rule, because a model that "cannot find a tool"
for a programmatic read is exactly the model that starts a websocket.

The default mode is **attach**: the server drives the Chrome you already use (or the browser a
`--cdp-endpoint` names). That is one session, one daemon, one connection — the rule still holds. The
opt-in in the other direction is `--mode launch`, which starts a dedicated Chrome with its own
profile directory, so the browser you use is never touched and no prompt appears at all.

## Sessions and isolation

An MCP connection is a session, and a session owns a browser session: its own sidecar, its own
DevTools connection, its own tab, and — in launch mode — its own profile directory.

| Transport | What one agent gets | What two agents get |
| --- | --- | --- |
| stdio (default) | one server process, one browser session | two processes; in attach mode both drive the same browser in their own tabs, in launch mode two browsers |
| Streamable HTTP | one MCP session, one browser session | one long-running server; attach mode shares the running browser, launch mode gives each session its own tab of a dedicated browser |

**Attach mode (default)** means every session drives the same browser you already use. That browser
is shared by default (`--attach-sharing shared`): each session gets its own sidecar, daemon and tab,
and Chrome asks "Allow remote debugging?" once per connection, so N live sessions mean N prompts.
`--attach-sharing exclusive` claims the DevTools endpoint through a lock file under
`<state root>/attachments/` and refuses the second live holder with a fix.

**Launch mode** gives every session a browser this server owns. Two servers configured with the
**same profile** are refused rather than silently sharing a browser: the first holds a lock file in
the profile directory, and the second gets a tool error naming `--profile`. A lock left by a crashed
process is reclaimed automatically.

**Named profiles.** In launch mode an anonymous HTTP session's profile
(`profiles/<profile>-<session suffix>`) is removed when the session ends. A client that names its
profile (`/mcp?profile=<name>` or `X-Browser-Use-Profile: <name>` on the initialize request) gets the
stable `profiles/<profile>-<name>` instead: it survives reconnects, its logins with it, and two live
sessions with the same name are refused by the profile lock rather than silently sharing one
browser. This is how several agents share one HTTP endpoint while each keeps its own logins.

The HTTP transport closes a session's browser after 15 minutes of silence
(`BROWSER_USE_MCP_HTTP_IDLE_MS` overrides that), so a client that disappears does not leave Chrome
running forever. Named profiles are kept; only anonymous session directories are removed.

## The Python environment

The engine is a Python package with Python dependencies; `npm install` cannot build one. So this
package carries what it needs:

- `vendor/jev_ultrafast-0.1.1-py3-none-any.whl` — the engine, built from a pinned upstream revision
  (`vendor/jev-ultrafast.json`).
- `vendor/requirements.txt` — the sidecar's dependencies (`browser-harness`, `cdp-use`, …), pinned by
  version *and* by the hash of every artifact.

On first use it finds a Python 3.12+ on the machine (or uses `uv`, which can fetch one), creates
`<state root>/env`, and installs the requirements with `uv pip` (or `pip --require-hashes` without
uv). One install at a time, across processes, via a lock in the state root. The environment is probed
by importing the engine, and `install.json` records what was built.

The state root is `${BROWSER_USE_MCP_HOME:-~/.browser-use-mcp}`:

```text
~/.browser-use-mcp/
├── env/                 managed Python virtualenv (engine + browser-harness)
├── install.json         what was installed, with which strategy and Python
├── profiles/<name>/     launched and named profiles (logins, tabs)
└── attachments/<hash>.lock   exclusive attach-mode claims, one per DevTools endpoint
```

`browser-use-mcp install` builds the environment eagerly; `browser-use-mcp doctor` reports it without
building anything. Serve mode starts the check in the background while the agent reads its
instructions, so a first call rarely waits for it.

## The Jev policy (optional)

`browser_goal` and `browser_act`'s `intent` spend model quota. Who answers them is configuration:

- `--jev-decider typesafe` (default): Jev, the System One policy at the TypeSafe endpoint, needs
  `TYPESAFE_API_KEY` (and optionally `TYPESAFE_BASE_URL` / `TYPESAFE_MODEL`).
- `--jev-decider chat`: the engine serves the System One protocol on loopback and a chat model
  answers it; needs `TEXT_MODEL_BASE_URL` and `TEXT_MODEL` (plus `TEXT_MODEL_API_KEY` for the
  endpoint).

`TEXT_MODEL_*` is also what writes a `TYPE_TEXT` value when the agent gives an intent but no text.
Without any of this configured, the rest of the tool surface works exactly the same; the policy
tools refuse with one sentence naming the variable to set.

The engine variables travel with each individual request that spends quota and are never left in the
server's environment or the sidecar's, so a stale key cannot leak into an unrelated call.

## Failure semantics

- A **refusal** is a normal tool result: nothing executed, plus the table to choose again from.
  Stale pages, unsupported targets, missing text and unconfigured policy are refusals.
- A **failed call** (`isError: true`) is used when the browser or its environment is the problem:
  engine not installed, profile busy, sidecar died, browser error. A model should report these
  rather than retry them blindly.
- A **cancelled** call is text saying the browser may still finish what it started: the page may have
  changed, so the next step must read it again.
- Page content is untrusted data. The server instructions say so, and nothing returned from a page
  is executed on the server's behalf.

## What is reused, and what is not

Reused from `dsh-browser-use` (MIT, see [NOTICE](../NOTICE)):

- `sidecar/bridge.py`, the line-delimited JSON sidecar — behaviour unchanged.
- The engine (`jev_ultrafast`) and its `browser-harness` connection layer, as the bundled wheel.
- The action-space rendering, the freshness rule, the "one connection" rule, the exact operation set,
  and the direct-mode tool descriptions.
- The provisioning approach: bundled wheel + hash-pinned requirements into a managed virtualenv.

Not part of this project, because an MCP client already is the agent:

- the delegated browser subagent (`browser_task`) and its progress feed;
- the DSH inspector/side panel and the session-level browser ownership of agents;
- the DSH configuration system (Cordis overlay, settings page, credentials service) — replaced by
  flags and environment variables that any MCP client can pass.
