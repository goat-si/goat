#!/usr/bin/env bash
# Regenerate the Codex app-server JSON Schema from the installed codex and diff it against the pinned copy.
#   scripts/codex-schema-refresh.sh          diff only; exit 1 when the pinned copy differs
#   scripts/codex-schema-refresh.sh --write  replace crates/goat2-engine-codex/schema/codex-<version>/ and its .md
set -euo pipefail
write=0
if [[ "${1:-}" == "--write" ]]; then write=1; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
schema_dir="$root/crates/goat2-engine-codex/schema"
version="$(codex --version | awk '{print $2}')"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
codex app-server generate-json-schema --experimental --out "$tmp/out" >/dev/null
target="$schema_dir/codex-$version"
if [[ -d "$target" ]]; then
  if diff -ru "$target" "$tmp/out"; then
    echo "codex $version: pinned schema matches the installed codex"
    exit 0
  fi
  if [[ $write -eq 0 ]]; then
    echo "codex $version: pinned schema differs (run with --write to replace it)" >&2
    exit 1
  fi
else
  newest="$(ls -d "$schema_dir"/codex-*/ 2>/dev/null | sort -V | tail -1 || true)"
  echo "new codex version $version"
  if [[ -n "$newest" ]]; then diff -ru --brief "$newest" "$tmp/out" || true; fi
  if [[ $write -eq 0 ]]; then exit 1; fi
fi
rm -rf "$target"
cp -R "$tmp/out" "$target"
cat > "$schema_dir/codex-$version.md" <<EOF
# codex $version app-server schema

- Source: installed \`codex --version\` = \`$(codex --version)\`
- Command: \`codex app-server generate-json-schema --experimental --out schema/codex-$version\`
- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(uname -s) $(uname -m)
- \`--experimental\` because the driver initializes with \`experimentalApi: true\` (as GOAT v1 does).
- Regenerate and diff with \`scripts/codex-schema-refresh.sh\`; never edit files in the bundle by hand.
