# 061 — Cycle 2 (wp2: item 1 bundled runtime)

Committed bundled archives (release darwin-arm64/linux-x64/linux-arm64 with sidecars, version = packaged server version), acquisition bundle → cache → mirror/gh, desktop resourcesPath + backend env + WSLENV cleanup + server dispatch, build-desktop-artifact --ssh-runtime-archive-dir, release workflows produce archives before bundling (preview skips), dev:runtime-archive with executable/version verification. Audit 01a128af FAIL→NEAR-PASS; review 01a128be FAIL→PASS. Receipt ssh 151, server 27, desktop 49, scripts 135.
Pessimist: release workflows are disabled in goat-si/goat, so the CI DAG change is validated by tests only; real packaging is exercised in wp5 (host archive only).
Next: wp3 (030 identity/updates) — stale-check against this commit; D9 import choice still pending from the user (default fresh ~/.goat/desktop with manual import script).
