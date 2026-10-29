# Upstream patches

`browser-use-mcp` vendors two pieces of upstream work: the sidecar bridge from
[`dsh-browser-use`](https://github.com/ricardochen1996/dsh-browser-use) and the browser engine
[`jev-ultrafast`](https://github.com/ricardochen1996/jev-ultrafast), bundled as a wheel. Two bugs
found while testing `browser-use-mcp` v0.1.2 live in that upstream code, so the fixes are carried
here as unified diffs against the pinned upstream revisions: the vendored copies in this package are
built from exactly these patches, and the patches can be applied upstream as they are.

Both apply to a clean checkout at the revision named below.

| Patch | Upstream | Base revision | Files |
| --- | --- | --- | --- |
| `jev-ultrafast-page-load-timeout.patch` | `jev-ultrafast` v0.1.1 | `50b319fd3e56052232b3a8de5695af9d30f77efb` | `jev_ultrafast/browser.py`, `pyproject.toml` (0.1.1 → 0.1.2), `uv.lock`, new `tests/test_page_load_timeout.py` |
| `dsh-browser-use-diagnostics-and-daemon-loss.patch` | `dsh-browser-use` v0.8.2 | `dfe8bfc5221cb6573c1a29bb258059f9a430cd0d` | `sidecar/bridge.py`, `test/test_bridge.py` |

## How to apply

```sh
git clone https://github.com/ricardochen1996/jev-ultrafast
cd jev-ultrafast
git checkout 50b319fd3e56052232b3a8de5695af9d30f77efb
git apply /path/to/browser-use-mcp/patches/jev-ultrafast-page-load-timeout.patch
uv run pytest tests/test_page_load_timeout.py
```

```sh
git clone https://github.com/ricardochen1996/dsh-browser-use
cd dsh-browser-use
git checkout dfe8bfc5221cb6573c1a29bb258059f9a430cd0d
git apply /path/to/browser-use-mcp/patches/dsh-browser-use-diagnostics-and-daemon-loss.patch
uv run pytest test/test_bridge.py
```

The wheel this package ships is built from the patched `jev-ultrafast` tree
(`UV_CACHE_DIR=/tmp/uv-cache uv build`; the artifact is
`dist/jev_ultrafast-0.1.2-py3-none-any.whl`). The vendored `sidecar/bridge.py` is the patched
upstream file with only its module docstring rewritten for this host; `NOTICE` records both vendored
files, their revisions, and their SHA-256 hashes.

## What the engine patch changes

`Browser.__init__` navigated with `self.call("Page.navigate", url=url)`, which inherits
`browser_harness.helpers.cdp()`'s 5 s IPC response timeout — a value sized for one CDP round trip.
A slow origin (TLS handshake, redirect chain, cold profile) exceeds it, and the run failed with
`Page.navigate timed out after 5s` while the browser was still loading the page. The patch adds
`PAGE_LOAD_TIMEOUT_SECONDS = 120.0` and passes it as `_response_timeout` for that one call. The
parameter is consumed by `cdp()` and never sent to Chrome. Every other call keeps the harness
default: `browser_eval`/`Browser.evaluate` rely on the caller's own `timeout_ms`, and the settle
loop below the navigation is what actually bounds the page load.

## What the bridge patch changes

`browser_console` (`diagnostics`) was always empty. `console_events()` filters the daemon's event
buffer by the CDP session the *engine* drives, but Browser Harness only enabled `Runtime` and
`Network` on the session it attached to when the daemon started, so the run's own tab session
emitted no console entries or failed-request events. The patch adds a
`DiagnosticsBrowser(EngineBrowser)` whose `attach()` enables both domains immediately after the
engine attaches a tab — before the engine navigates it — and makes it `Session`'s default
`open_browser`. Because `follow_opened_tab` goes through the same `attach()`, a tab a click opens
is watched the moment it is attached. That is what makes the page's own load visible: Chrome
replays `Runtime` console messages and `exceptionThrown` when the domain is enabled, but it does
not replay `Network` events, so a request that failed while the page loaded is only in the buffer
when the domain was already on. Load-time console output, exceptions and failed/4xx requests are
therefore all reported, along with anything the page does afterwards.

`Session._watch_diagnostics()` stays as the safety net for a session the engine creates another
way — a caller's own `open_browser`, or a session switched without an attach this sidecar
observed — and runs in `open()`, after `observe()`/`act()`, and in `diagnostics()`. It is best
effort: a domain that cannot be enabled never fails the browser call it belongs to.

The same patch turns a vanished daemon into an actionable refusal. When a request raises
`FileNotFoundError`/`ConnectionRefusedError` and `_ipc.ping(helpers.NAME)` shows the daemon is gone,
`dispatch()` answers `{"kind": "lost_session", ...}` telling the caller to call `browser_open` again,
instead of returning `browser_error` with a raw Python traceback line. This is what a stdio server
saw after another server process sharing its daemon exited; the host side additionally gives each
server process its own daemon name (see `lib/sidecar.js`).

Finally, the end of `serve()` now shuts the sidecar down instead of only closing its tab. A host
that dies without sending a shutdown request — a SIGKILLed MCP server — leaves this child nothing
but end-of-input, and the browser a launch-mode sidecar started is its own child: nobody else can
stop it, and a daemon nobody can reach must not keep it alive. The tail calls
`session.shutdown({})` (falling back to `session.close({})` if that raises), so a hard-killed
launch-mode server cannot leak the Chrome it launched. An explicit shutdown request followed by
end-of-input simply shuts down twice, which is harmless.
