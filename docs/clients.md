# Client wiring

`browser-use-mcp` speaks the Model Context Protocol. This page has copy-pasteable configuration for
the clients people actually use: **[Claude Code](#claude-code)**, **[Claude Desktop](#claude-desktop)**,
**[Cursor](#cursor)**, **[Codex](#codex)**, **[DSH](#dsh)**, and a plain
**[`mcpServers` JSON](#generic-mcpservers-json)** any MCP host understands. Every stdio snippet
starts `node` with the server's absolute path and runs from any working directory.

## Before you paste: three things

1. **Use your own absolute path.** The snippets below use this checkout's path,
   `/Users/ricardo.chen/PersonalGit/browser-use-mcp`. Replace it with wherever you cloned the
   repository. Do not rely on a relative path: GUI applications do not start in the directory you
   ran a shell command from.
2. **Make sure `node` is the Node 22+ you expect.** The server needs Node `^22.19.0 || >=24.0.0`.
   A GUI-launched client often has a shorter `PATH` than your shell. If it cannot find `node`, run
   `which node` in your shell and put that absolute path in `command` instead — for example
   `/opt/homebrew/bin/node`.
3. **stdout is the protocol; logs are stderr.** While serving MCP, stdout carries JSON-RPC frames
   and every log line goes to stderr. When a client shows nothing, run the exact command in a
   terminal: the JSON-RPC traffic appears on stdout and `browser-use-mcp …` log lines on stderr,
   which is where startup and engine-install problems are explained.

The package is **not published to npm yet**. Install from the checkout:

```bash
cd /Users/ricardo.chen/PersonalGit/browser-use-mcp
npm install
```

That is enough — the server itself is plain ESM. The Python side (the engine and `browser-harness`)
is provisioned automatically on first use, or ahead of time:

```bash
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs install
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs doctor
```

If you prefer a command name over an absolute path, `npm link` in the checkout puts
`browser-use-mcp` on your `PATH`; GUI clients may still not see that `PATH`, so the absolute path is
the reliable form. Every snippet below is **stdio** unless it says otherwise; the server's default
transport is stdio, one browser per server process.

Two defaults decide what the agent sees:

- **Transport stdio** — the client starts its own server process, and only that client uses it.
- **Mode attach** — the server drives the Chrome you already use, so the agent sees your logins and
  tabs. Enable remote debugging once in that Chrome (`chrome://inspect/#remote-debugging` → allow);
  on macOS the application running the server also needs Full Disk Access. If you would rather give
  the agent a dedicated browser, add `BROWSER_USE_MCP_MODE=launch` (and `BROWSER_USE_MCP_HEADLESS=1`
  for no window). `BROWSER_USE_MCP_PROFILE` and `BROWSER_USE_MCP_HEADLESS` only mean something in
  launch mode — the snippets below set `launch` where they use them.

---

## Claude Code

Two equivalent ways to wire it.

### CLI

```bash
# Attach mode (the default): use the Chrome you browse with.
claude mcp add --scope user browser-use \
  -- node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs

# Launch mode: a dedicated headless browser with its own profile.
claude mcp add --scope user browser-use \
  --env BROWSER_USE_MCP_MODE=launch \
  --env BROWSER_USE_MCP_HEADLESS=1 \
  --env BROWSER_USE_MCP_PROFILE=claude-code \
  -- node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs
```

- `--scope user` makes it available in every project. Use `--scope project` to write a `.mcp.json`
  in the current repository instead, or omit it for local-only.
- Add `--env TYPESAFE_API_KEY=…` (or the `TEXT_MODEL_*` group) to enable `browser_goal` and
  `browser_act` intents; see [Jev credentials](#jev-credentials).
- Check it with `claude mcp list`, then ask Claude to call `browser_doctor`.

### Project `.mcp.json`

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs"],
      "env": {
        "BROWSER_USE_MCP_MODE": "launch",
        "BROWSER_USE_MCP_HEADLESS": "1",
        "BROWSER_USE_MCP_PROFILE": "claude-code"
      }
    }
  }
}
```

---

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, or
`%APPDATA%\Claude\claude_desktop_config.json` on Windows. The file is plain JSON (no comments, no
trailing commas):

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs"],
      "env": {
        "BROWSER_USE_MCP_MODE": "launch",
        "BROWSER_USE_MCP_PROFILE": "claude-desktop"
      }
    }
  }
}
```

Fully quit and restart Claude Desktop after saving. In launch mode the browser window appears when
the model calls `browser_open`, not at startup; in attach mode it is already the Chrome you use.
`BROWSER_USE_MCP_MODE=launch` is what makes this client use a dedicated profile — give each client
its own `BROWSER_USE_MCP_PROFILE` if several clients will launch at once (two servers on one profile
are refused by design).

---

## Cursor

Project configuration goes in `.cursor/mcp.json`; to make it available everywhere, use
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs"],
      "env": {
        "BROWSER_USE_MCP_MODE": "launch",
        "BROWSER_USE_MCP_HEADLESS": "1",
        "BROWSER_USE_MCP_PROFILE": "cursor"
      }
    }
  }
}
```

Reload the window (or restart Cursor) after editing. The tools appear in **Settings → MCP** once the
server answers an `initialize`.

---

## Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.browser-use]
command = "node"
args = ["/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs"]
startup_timeout_sec = 120

[mcp_servers.browser-use.env]
BROWSER_USE_MCP_MODE = "launch"
BROWSER_USE_MCP_HEADLESS = "1"
BROWSER_USE_MCP_PROFILE = "codex"
```

`startup_timeout_sec` is optional; a first run that has to provision the Python environment can take
a minute or two, so raise it if your Codex build gives up before the server answers. Restart Codex
after saving, then check that `browser_doctor` is in its tool list.

---

## DSH

DSH loads MCP servers through its `@deepseek-ai/dsh-mcp-client` plugin, configured in the profile's
`cordis.patch.yml` (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`; `DSH_HOME` defaults to
`~/.dsh`, and the standard Web UI profile is `web`). The row is namespaced: its tools appear as
`mcp__browser-use__browser_open` and so on.

**stdio** — DSH starts the server itself:

```yaml
- insert:
    - id: browser-use-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser-use
        transport: stdio
        command: node
        args:
          - /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs
        env:
          BROWSER_USE_MCP_MODE: launch
          BROWSER_USE_MCP_HEADLESS: '1'
          BROWSER_USE_MCP_PROFILE: dsh
        failOnStartupError: true
```

**Streamable HTTP** — point at a server you started yourself (see
[one shared HTTP server](#one-shared-http-server)):

```yaml
- insert:
    - id: browser-use-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser-use
        transport: streamable-http
        url: http://127.0.0.1:7331/mcp
        failOnStartupError: true
```

A DSH detail worth knowing: the stdio transport merges the configured `env` over a **scrubbed**
ambient environment, and ambient names matching `KEY`, `PASSWORD`, `SECRET` or `TOKEN` are dropped.
So Jev credentials must be listed explicitly in `env` — they do not leak in from the shell:

```yaml
        # Jev credentials must be repeated in env: ambient names matching KEY/TOKEN are scrubbed.
        env:
          BROWSER_USE_MCP_MODE: launch
          BROWSER_USE_MCP_HEADLESS: '1'
          TYPESAFE_API_KEY: !!js process.env.TYPESAFE_API_KEY
```

Restart the harness if the row is new. Both variants accept the same other `config` fields as any
`dsh-mcp-client` entry (`reconnect`, `toolCallTimeoutMs`, …).

---

## Generic `mcpServers` JSON

Most MCP hosts read a JSON object with one entry per server. This is the same shape as the Claude
Desktop and Cursor snippets, with the most common knobs shown:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": [
        "/Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs",
        "--mode", "launch",
        "--headless",
        "--profile", "my-agent"
      ],
      "env": {
        "BROWSER_USE_MCP_HEADLESS": "1",
        "BROWSER_USE_MCP_PROFILE": "my-agent",
        "BROWSER_USE_MCP_HOME": "/Users/me/.browser-use-mcp"
      }
    }
  }
}
```

Server flags go in `args`; environment variables go in `env`. `--headless` and
`BROWSER_USE_MCP_HEADLESS=1` mean the same thing — either spelling is fine, and a flag wins if both
are present. The full list is in the [configuration reference](config.md).

Mutually equivalent spellings for the same settings:

| Setting | Flag | Env |
| --- | --- | --- |
| Headless | `--headless` | `BROWSER_USE_MCP_HEADLESS=1` |
| Profile | `--profile my-agent` | `BROWSER_USE_MCP_PROFILE=my-agent` |
| State root | `--home /path` | `BROWSER_USE_MCP_HOME=/path` |
| No `browser_eval` | `--no-eval` | `BROWSER_USE_MCP_NO_EVAL=1` |
| Attach to a debug browser | `--mode attach --cdp-endpoint http://127.0.0.1:9333` | `BROWSER_USE_MCP_MODE=attach`, `BROWSER_USE_MCP_CDP_ENDPOINT=http://127.0.0.1:9333` |

### Environment examples

Headless, separate profile, explicit state root:

```json
"env": {
  "BROWSER_USE_MCP_HEADLESS": "1",
  "BROWSER_USE_MCP_PROFILE": "agent-a",
  "BROWSER_USE_MCP_HOME": "/Users/me/.browser-use-mcp"
}
```

Jev credentials belong in `env`, never in `args` (arguments are visible in process listings):
see the next section.

---

## Jev credentials

`browser_goal` and `browser_act`'s `intent` are optional; the rest of the tool surface never spends
model quota. Two ways to make the policy work:

**TypeSafe decider** (default) — Jev answers the policy questions:

```json
"env": {
  "TYPESAFE_API_KEY": "your-key",
  "TYPESAFE_BASE_URL": "https://…",
  "TYPESAFE_MODEL": "…"
}
```

Only `TYPESAFE_API_KEY` is required; the other two have engine defaults. `TEXT_MODEL_*` is still
wanted if the policy should write `TYPE_TEXT` values.

**Chat decider** — a text model answers instead:

```json
"env": {
  "JEV_DECIDER": "chat",
  "TEXT_MODEL_BASE_URL": "https://your-endpoint/v1",
  "TEXT_MODEL": "your-model",
  "TEXT_MODEL_API_KEY": "your-key"
}
```

`--jev-decider chat` in `args` is equivalent to `JEV_DECIDER=chat`. To keep the surface entirely
policy-free, pass `--no-jev` (or `BROWSER_USE_MCP_NO_JEV=1`).

The doctor reports only `set`/`unset` for keys, never a value, and a missing key is a refusal that
names the variable, not a crash.

---

## One shared HTTP server

Running a long-lived HTTP endpoint is how several agents share one installed server instead of each
starting a stdio process. Each MCP session still gets its own browser session, sidecar and tab, so
two agents never click on one page by accident.

Start it once:

```bash
# Default: every session drives the Chrome you already use (attach, shared by default).
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs \
  --transport http --host 127.0.0.1 --port 7331 --path /mcp

# Or: every session gets a tab in one dedicated browser this server launches.
node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs \
  --transport http --host 127.0.0.1 --port 7331 --path /mcp \
  --mode launch --headless
```

The endpoint is then `http://127.0.0.1:7331/mcp`. Flags given here apply to every session; clients
only supply the URL.

**Persistent per-agent profiles (launch mode).** An anonymous session's profile is deleted when the
session ends. To keep logins across reconnects, the client names its profile on the initialize
request — in the URL, `http://127.0.0.1:7331/mcp?profile=claude`, or with the header
`X-Browser-Use-Profile: claude`. Different names run at once on different profiles; two live
sessions with the same name are refused (the profile is one browser's at a time). The snippets below
show the URL form.

- **Claude Code**

  ```bash
  claude mcp add --transport http --scope user browser-use \
    "http://127.0.0.1:7331/mcp?profile=claude"
  ```

- **Claude Code project config**

  ```json
  {
    "mcpServers": {
      "browser-use": { "type": "http", "url": "http://127.0.0.1:7331/mcp?profile=claude" }
    }
  }
  ```

- **Cursor** (`~/.cursor/mcp.json`)

  ```json
  {
    "mcpServers": {
      "browser-use": { "url": "http://127.0.0.1:7331/mcp?profile=cursor" }
    }
  }
  ```

- **Codex** (`~/.codex/config.toml`)

  ```toml
  [mcp_servers.browser-use]
  url = "http://127.0.0.1:7331/mcp"
  ```

- **DSH** — use the `streamable-http` row [above](#dsh).

- **Any client that only says "URL"** — use `http://127.0.0.1:7331/mcp`, or add
  `?profile=<name>` for a persistent per-agent profile in launch mode.

Notes:

- There is **no authentication**. Keep the bind on `127.0.0.1`; if it must be reachable from
  elsewhere, put it behind a tunnel or reverse proxy you control.
- An idle session's browser is closed after 15 minutes; raise or lower that with
  `BROWSER_USE_MCP_HTTP_IDLE_MS` (milliseconds, positive) in the server's environment.
- A client that disappears without terminating its session is cleaned up by the same idle sweep; an
  explicit terminate cleans up at once.
- In launch mode browsers are launched per session with a profile directory under the state root:
  anonymous ones are removed when the session ends, a `?profile=<name>` one is kept. In attach mode
  (the default) every session drives the same already-running browser, shared by default — see
  `--attach-sharing` in the [configuration reference](config.md).

---

## If a client shows no tools

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Client says the server exited immediately | `node` not found, or a bad flag value | Run the same command in a terminal and read stderr; a configuration error exits with code `2` and names the field. |
| Server starts but no tools appear | Wrong config file, or the client was not restarted | Use the client's MCP list/log view; restart the client after editing its config. |
| First call takes minutes, then works | First run is provisioning the Python environment | Wait, or run `node /Users/ricardo.chen/PersonalGit/browser-use-mcp/bin/browser-use-mcp.mjs install` first. Behind a proxy, set `HTTPS_PROXY`. |
| `browser_doctor` reports `Status: ready` but calls fail | The profile is held by another server, or the browser process died | Read the failure text — a profile collision names `--profile`; a dead browser is rebuilt on the next `browser_open`. |
| Profile lock error naming `--profile` | Two servers on one browser profile | Stop the other server or give this one `--profile <other-name>`. |
| Attach mode cannot find your Chrome (macOS) | Full Disk Access missing | System Settings → Privacy & Security → Full Disk Access, add the host app, restart it. |
| Chrome shows "Allow remote debugging?" | A second CDP client is running | Approve the prompt once, never retry; stop the extra client. The session's own tools share one connection. |

For the design behind the freshness rule and the one-connection rule, read
[architecture.md](architecture.md). For every flag and variable, read [config.md](config.md).
