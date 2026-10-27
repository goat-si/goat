#!/bin/bash
# Verify a goat-ci run attempt on EPYC for the current worktree HEAD (no local test execution).
# Usage: ci-verify.sh <run-id> <expected-run-attempt>
set -euo pipefail
RUN="$1"; ATTEMPT="$2"
WT=/Users/jun/Developer/goat.worktrees/ci-speedup
head=$(git -C "$WT" rev-parse HEAD)
read -r status conclusion sha attempt < <(gh api "repos/goat-si/goat/actions/runs/$RUN" --jq '[.status,.conclusion,.head_sha,.run_attempt] | @tsv')
echo "run $RUN attempt=$attempt status=$status conclusion=$conclusion sha=${sha:0:9} head=${head:0:9}"
if ! { [ "$attempt" = "$ATTEMPT" ] && [ "$status" = completed ] && [ "$conclusion" = success ] && [ "$sha" = "$head" ]; }; then
  echo "REJECT: run attempt/status/conclusion/sha mismatch" >&2
  exit 1
fi
jobs=$(gh api "repos/goat-si/goat/actions/runs/$RUN/attempts/$ATTEMPT/jobs")
jq -r '.jobs[] | "\(.name) \(.conclusion) attempt=\(.run_attempt) \(.started_at) -> \(.completed_at) \(.runner_name)"' <<<"$jobs"
jid=$(jq -r --argjson a "$ATTEMPT" '.jobs[] | select(.name=="goat-test" and .run_attempt==$a and .conclusion=="success") | .id' <<<"$jobs")
if [ -z "$jid" ]; then echo "REJECT: no successful goat-test job in attempt $ATTEMPT" >&2; exit 1; fi
log=$(gh api "repos/goat-si/goat/actions/jobs/$jid/logs" | sed -E 's/\x1b\[[0-9;]*m//g')
grep -m1 -A3 'Test Files  17' <<<"$log" | grep -E 'Test Files|Tests |Duration' || true
grep -q 'Test Files  17 passed (17)' <<<"$log" || { echo "REJECT: ssh file count" >&2; exit 1; }
grep -q 'Tests  383 passed (383)' <<<"$log" || { echo "REJECT: ssh test count" >&2; exit 1; }
n=$(grep -cE '✓ src/tunnel\.(core|runner-switch|protocol-[a-z]+)\.test\.ts' <<<"$log" || true)
busy=$(grep -c EADDRINUSE <<<"$log" || true)
echo "goat-test job $jid; tunnel split files passed: $n; EADDRINUSE lines: $busy"
if [ "$n" -ne 10 ] || [ "$busy" -ne 0 ]; then echo "REJECT: split files or EADDRINUSE" >&2; exit 1; fi
echo CI_VERIFIED
