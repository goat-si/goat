#!/bin/sh
set -eu
root= scenario= out= allow_git=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --v1-root) root=${2:?missing root}; shift 2 ;;
    --scenario) scenario=${2:?missing scenario}; shift 2 ;;
    --out) out=${2:?missing output}; shift 2 ;;
    --allow-git-checkout) allow_git=true; shift ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[ -n "$root" ] && [ -n "$scenario" ] && [ -n "$out" ] || { echo 'expected --v1-root, --scenario and --out' >&2; exit 1; }
root=$(cd "$root" && pwd -P)
scenario=$(cd "$scenario" && pwd -P)
out_dir=$(cd "$(dirname "$out")" && pwd -P)
out="$out_dir/$(basename "$out")"
if [ -e "$root/.git" ] && [ "$allow_git" != true ]; then
  echo 'refusing git checkout without --allow-git-checkout' >&2; exit 1
fi
src=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
dest="$root/apps/server/src/orchestration-v2/testkit/goat2-parity"
[ -f "$src/ParityScenarios.integration.test.ts" ] || { echo 'v1 replay driver not implemented' >&2; exit 1; }
mkdir "$dest" || { echo "refusing existing or inaccessible destination: $dest" >&2; exit 1; }
trap 'rm -rf "$dest"' EXIT HUP INT TERM
cp "$src"/*.ts "$dest/"
GOAT2_PARITY_SCENARIO="$scenario" GOAT2_PARITY_OUT="$out" pnpm --dir "$root/apps/server" exec vp test run src/orchestration-v2/testkit/goat2-parity/ParityScenarios.integration.test.ts
[ -f "$out" ] || { echo 'runner did not produce output' >&2; exit 1; }
