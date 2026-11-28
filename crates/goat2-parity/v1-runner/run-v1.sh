#!/bin/sh
set -eu
root= scenario= out= allow_git=false unit=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --v1-root) root=${2:?missing root}; shift 2 ;;
    --scenario) scenario=${2:?missing scenario}; shift 2 ;;
    --out) out=${2:?missing output}; shift 2 ;;
    --allow-git-checkout) allow_git=true; shift ;;
    # --unit: run the runner's own unit tests (*.test.ts) in the copy instead of a scenario.
    --unit) unit=true; shift ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
if [ "$unit" = true ]; then
  [ -n "$root" ] || { echo 'expected --v1-root' >&2; exit 1; }
  root=$(cd "$root" && pwd -P)
  [ ! -e "$root/.git" ] || [ "$allow_git" = true ] || { echo 'refusing git checkout without --allow-git-checkout' >&2; exit 1; }
  src=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
  name="goat2-parity-unit-$$"
  dest="$root/apps/server/src/orchestration-v2/testkit/$name"
  mkdir "$dest" || { echo "refusing existing or inaccessible destination: $dest" >&2; exit 1; }
  trap 'rm -rf "$dest"' EXIT HUP INT TERM
  cp "$src"/*.ts "$dest/"
  pnpm --dir "$root/apps/server" exec vp test run "src/orchestration-v2/testkit/$name/traceFromV1Mcp.test.ts"
  exit
fi
[ -n "$root" ] && [ -n "$scenario" ] && [ -n "$out" ] || { echo 'expected --v1-root, --scenario and --out' >&2; exit 1; }
root=$(cd "$root" && pwd -P)
scenario=$(cd "$scenario" && pwd -P)
out_dir=$(cd "$(dirname "$out")" && pwd -P)
out="$out_dir/$(basename "$out")"
if [ -e "$root/.git" ] && [ "$allow_git" != true ]; then
  echo 'refusing git checkout without --allow-git-checkout' >&2; exit 1
fi
src=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
# One directory per run (same depth, so the runner's relative imports resolve) lets
# concurrent runs share one export without touching each other's copy.
name="goat2-parity-$$"
dest="$root/apps/server/src/orchestration-v2/testkit/$name"
[ -f "$src/ParityScenarios.integration.test.ts" ] || { echo 'v1 replay driver not implemented' >&2; exit 1; }
mkdir "$dest" || { echo "refusing existing or inaccessible destination: $dest" >&2; exit 1; }
trap 'rm -rf "$dest"' EXIT HUP INT TERM
cp "$src"/*.ts "$dest/"
# Scenarios with more than one thread or any MCP step run through the MCP driver.
test_file=ParityScenarios.integration.test.ts
if node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Object.keys(s.threads).length>1||s.steps.some(x=>x.do==="mcp"||x.do==="await_call")?0:1)' "$scenario/scenario.json"; then
  test_file=ParityMcpScenarios.integration.test.ts
fi
GOAT2_PARITY_SCENARIO="$scenario" GOAT2_PARITY_OUT="$out" pnpm --dir "$root/apps/server" exec vp test run "src/orchestration-v2/testkit/$name/$test_file"
[ -f "$out" ] || { echo 'runner did not produce output' >&2; exit 1; }
