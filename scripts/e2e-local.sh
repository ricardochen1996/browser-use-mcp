#!/usr/bin/env bash
# Run the real-browser end-to-end suites on this machine.
#
# The suites drive real Chrome, and the launch-mode ones let the server start it. On a developer
# machine inside a sandbox Chrome cannot nest its own sandbox, and Browser Harness would write its
# daemon files under $HOME. This wrapper keeps a run inside one temporary directory: a Chrome wrapper
# with --no-sandbox, a fresh test state root, and a private runtime directory handed to the engine,
# so nothing outside this run is touched and a failed suite cannot leave a browser behind.
#
# Usage:
#   npm run test:e2e:local                 # every suite this machine can run
#   npm run test:e2e:local -- http attach  # named suites only
#
# The stdio suite needs `ps`; it is skipped (with a note) where that is unavailable. Every other suite
# needs only a Chrome. Exit status is non-zero when any suite failed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEFAULT_SUITES=(stdio http attach daemon-isolation intent protocol)
suites=("$@")
if [[ ${#suites[@]} -eq 0 ]]; then
  suites=("${DEFAULT_SUITES[@]}")
fi

# A Chrome to drive: BROWSER_USE_MCP_TEST_CHROME names one, otherwise use this machine's. The
# attach/daemon-isolation/stdio suites read that variable, and a launch-mode server reads
# BROWSER_USE_MCP_EXECUTABLE_PATH; both point at the wrapper built below.
chrome="${BROWSER_USE_MCP_TEST_CHROME:-}"
if [[ -z "$chrome" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/usr/bin/google-chrome" \
    "/usr/bin/google-chrome-stable" \
    "/usr/bin/chromium" \
    "/usr/bin/chromium-browser"; do
    if [[ -x "$candidate" ]]; then chrome="$candidate"; break; fi
  done
fi
if [[ -z "$chrome" ]]; then
  echo "no Chrome or Chromium found: set BROWSER_USE_MCP_TEST_CHROME to the browser to drive" >&2
  exit 1
fi

# The state root has to stay short: Browser Harness binds an AF_UNIX socket inside its runtime
# directory, and macOS's tmpdir (/var/folders/...) resolves through a symlink to a long /private/var/...
# path that eats most of the 104-byte budget. /tmp is the shortest writable base on the systems this
# script targets; E2E_LOCAL_TMPDIR overrides it.
base="${E2E_LOCAL_TMPDIR:-/tmp}"
if [[ ! -d "$base" || ! -w "$base" ]]; then base="${TMPDIR:-/tmp}"; fi
work="$(mktemp -d "$base/browser-use-mcp-e2e.XXXXXX")"
runtime="$work/runtime"
mkdir -p "$runtime" "$work/home" "$work/tmp"

# Chrome aborts a few seconds after DevTools appears when it cannot nest its own sandbox; the extra
# flags only affect this test browser, never the user's.
cat > "$work/chrome" <<WRAPPER
#!/bin/sh
exec "$chrome" --no-sandbox --disable-gpu --disable-crash-reporter --disable-breakpad "\$@"
WRAPPER
chmod +x "$work/chrome"

export BROWSER_USE_MCP_TEST_CHROME="$work/chrome"
export BROWSER_USE_MCP_EXECUTABLE_PATH="$work/chrome"
export BROWSER_USE_MCP_TEST_HOME="$work/home"
export BH_RUNTIME_DIR="$runtime"
export BH_TMP_DIR="$work/tmp"
# uv's cache is kept between runs so the engine is installed once; it must not fall back to a cache
# under $HOME, which a sandbox may refuse to write.
export UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/browser-use-mcp-e2e-uv-cache}"

cleanup() {
  # A failed suite can leave the browser it launched; the suites clean up after themselves only when
  # they finish. Everything this run started names its own temporary directory, so stopping by that
  # path cannot touch a browser the user is working in.
  local pid_file pid
  for pid_file in "$runtime"/*.pid; do
    [[ -e "$pid_file" ]] || continue
    pid="$(tr -cd '0-9' < "$pid_file")"
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  pkill -f "$work" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

failed=()
ran=0
for suite in "${suites[@]}"; do
  case "$suite" in
    stdio)
      if ! ps -ax >/dev/null 2>&1; then
        echo "note: skipping the stdio suite: ps is unavailable in this environment" >&2
        continue
      fi
      ;;
    http | attach | daemon-isolation | intent | protocol) ;;
    *)
      echo "unknown suite \"$suite\" (expected one of: ${DEFAULT_SUITES[*]})" >&2
      exit 2
      ;;
  esac
  ran=$((ran + 1))
  echo ""
  echo "=== ${suite} (${ran}/${#suites[@]}) ==="
  if ! node "test/e2e/${suite}.mjs"; then
    failed+=("$suite")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "" >&2
  echo "failed: ${failed[*]}" >&2
  exit 1
fi
if [[ "$ran" -eq 0 ]]; then
  echo "no suite could run on this machine" >&2
  exit 1
fi
echo ""
echo "all ${ran} suite(s) passed"
