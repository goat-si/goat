# codex 0.167.0 app-server schema

- Source: installed `codex --version` = `codex-cli 0.167.0`
- Command: `codex app-server generate-json-schema --experimental --out schema/codex-0.167.0`
- Generated: 2026-11-28T12:37:27Z on Darwin arm64
- `--experimental` because the driver initializes with `experimentalApi: true` (as GOAT v1 does).
- Regenerate and diff with `scripts/codex-schema-refresh.sh`; never edit files in the bundle by hand.
