#!/usr/bin/env bash
# Run one end-to-end suite and make its failure readable without downloading the job log.
#
# The logs of a public repository's Actions run still require a signed-in user, so a red run would
# otherwise say only "Process completed with exit code 1". Annotations, however, are rendered on the
# run page for anyone who can read the repository. The suites print their failure as
# `FAIL: <error>` followed by a stack whose `at main (...)` frame names the suite file and line, so
# both are lifted into annotations.
set +e

suite="${1:?usage: e2e-suite.sh <stdio|http|attach|intent|protocol>}"
log="${RUNNER_TEMP:-/tmp}/e2e-${suite}.log"

echo "::group::test/e2e/${suite}.mjs"
node "test/e2e/${suite}.mjs" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
echo "::endgroup::"

if [[ "$code" -ne 0 ]]; then
  grep -E '^FAIL:|^[[:space:]]+at main \(file' "$log" | head -8 | while IFS= read -r line; do
    line="${line//$'\n'/ }"
    echo "::error title=${suite} end-to-end::${line}"
  done
fi

exit "$code"
