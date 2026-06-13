#!/bin/bash
# Runs all test suites and prints a single consolidated summary.
# Full output for each suite is captured to a log file (path printed at the
# end) so failures can be inspected without re-running.
set -uo pipefail

LOGDIR=$(mktemp -d)
SUITES=(backend-unit frontend-unit integration e2e)
declare -A STATUS
declare -A DETAIL

run() {
  local name="$1" dir="$2"; shift 2
  echo "Running $name..."
  if (cd "$dir" && "$@") >"$LOGDIR/$name.log" 2>&1; then
    STATUS[$name]="PASS"
  else
    STATUS[$name]="FAIL"
  fi
  DETAIL[$name]=$(sed -E 's/\x1b\[[0-9;]*m//g' "$LOGDIR/$name.log" | grep -E -i "tests?:|passed|failed" | tail -1 | sed -E 's/^[[:space:]]+//')
}

# To add a new suite (e.g. M3's toxiproxy scenario tests, M4 batch, ...):
#   1. add its name to SUITES above
#   2. add a `run <name> <dir> <command...>` line below
# The suite must exit non-zero on failure and print a summary line
# containing "passed"/"failed"/"tests:" (case-insensitive) for the detail
# column - true of Jest, Vitest and Playwright's default reporters.

run backend-unit  backend  npm test --silent

# Angular CLI requires Node 22+; fall back to a node:22 container if the host
# Node is older (see README).
if [ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" -ge 22 ]; then
  run frontend-unit frontend npx ng test --watch=false
else
  run frontend-unit . docker run --rm -v "$PWD:/workspace" -w /workspace/frontend \
    -u "$(id -u):$(id -g)" -e HOME=/tmp node:22 npx ng test --watch=false
fi

run integration   tests    npm run test:integration
run e2e            tests    npm run test:e2e

echo
echo "================ Test Summary ================"
for name in "${SUITES[@]}"; do
  printf "%-14s %-4s %s\n" "$name" "${STATUS[$name]}" "${DETAIL[$name]}"
done
echo "================================================"
echo "Full logs: $LOGDIR"

for name in "${SUITES[@]}"; do
  if [ "${STATUS[$name]}" = "FAIL" ]; then
    echo
    echo "----- $name (failed, last 40 lines) -----"
    tail -40 "$LOGDIR/$name.log"
  fi
done

for name in "${SUITES[@]}"; do
  [ "${STATUS[$name]}" = "PASS" ] || exit 1
done
