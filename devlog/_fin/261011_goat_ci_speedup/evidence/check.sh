#!/bin/bash
# wp1/wp2 check: tunnel tests + inventory + static gates in the ci-speedup worktree.
set -euo pipefail
WT=/Users/jun/Developer/goat.worktrees/ci-speedup
export PATH="$WT/node_modules/.bin:$PATH"
OUT="${1:-/tmp/goat-ci/check.json}"
cd "$WT/packages/ssh"
start=$(date +%s)
vp test run --config ../../vite.config.ts --dir . src/tunnel --reporter=json --outputFile="$OUT" > /tmp/goat-ci/check-test.log 2>&1
echo "tunnel tests wall: $(( $(date +%s) - start ))s"
node /tmp/goat-ci/inventory.mjs "$OUT" /tmp/goat-ci/baseline-names.txt 10
cd "$WT"
vp run --filter @t3tools/ssh typecheck > /tmp/goat-ci/check-tc.log 2>&1 && echo "typecheck ok"
vp lint packages/ssh/src > /tmp/goat-ci/check-lint.log 2>&1 && echo "lint ok ($(grep -c warning /tmp/goat-ci/check-lint.log) warnings)"
vp fmt --check packages/ssh/src > /dev/null 2>&1 && echo "fmt ok"
test -z "$(knip --workspace packages/ssh --exports --preprocessor ./scripts/knip-schemas.ts --no-config-hints 2>&1)" && echo "knip ok"
