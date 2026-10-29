#!/usr/bin/env bash
# Run one end-to-end suite, retrying it so a browser-timing flake does not redden the run, and make a
# final failure readable without downloading the job log.
#
# The end-to-end suites drive real Chrome and real processes; a step can fail on timing without
# anything being broken (a browser that has not finished exiting, a slow runner, a profile lock still
# held for a moment). The unit matrix is deliberately never retried: a failing unit test is a defect,
# not timing. `E2E_ATTEMPTS` (or the optional second argument) changes the number of attempts; the
# default is 2, i.e. one retry.
#
# The logs of a public repository's Actions run still require a signed-in user, so a red run would
# otherwise say only "Process completed with exit code 1". Annotations, however, are rendered on the
# run page for anyone who can read the repository. The suites print their failure as
# `FAIL: <error>` followed by a stack whose `at main (...)` frame names the suite file and line, so
# both are lifted into annotations after the last attempt.
set +e

suite="${1:?usage: e2e-suite.sh <stdio|http|attach|daemon-isolation|intent|protocol> [attempts]}"
attempts="${2:-${E2E_ATTEMPTS:-2}}"
if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "attempts must be a positive integer, got \"$attempts\"" >&2
  exit 2
fi
log="${RUNNER_TEMP:-/tmp}/e2e-${suite}.log"
code=1

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if [[ "$attempt" -gt 1 ]]; then
    echo "::warning title=${suite} end-to-end::attempt $((attempt - 1)) failed; retrying the suite (attempt ${attempt}/${attempts})"
    # A failed suite can leave a browser or daemon behind; clear this job's leftovers before retrying.
    pkill -f browser_harness.daemon 2>/dev/null || true
    pkill -f 'browser-use-mcp.mjs' 2>/dev/null || true
    sleep "${E2E_RETRY_DELAY_SECONDS:-5}"
  fi
  echo "::group::test/e2e/${suite}.mjs (attempt ${attempt}/${attempts})"
  node "test/e2e/${suite}.mjs" 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [[ "$code" -eq 0 ]]; then
    if [[ "$attempt" -gt 1 ]]; then
      echo "::notice title=${suite} end-to-end::passed on attempt ${attempt} after a flake"
    fi
    exit 0
  fi
done

grep -E '^FAIL:|^[[:space:]]+at main \(file' "$log" | head -8 | while IFS= read -r line; do
  line="${line//$'\n'/ }"
  echo "::error title=${suite} end-to-end::${line}"
done

exit "$code"
