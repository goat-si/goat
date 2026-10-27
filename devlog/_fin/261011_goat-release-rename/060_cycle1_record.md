# 060 — Cycle 1 record (wp1 roadmap + wp2 release source)

## Conclusion

Roadmap 000–050 written, reflected and audited (NEAR-PASS, no blockers). wp2 implemented and committed as `fe8df0d3a` on `codex/goat-release-rename` (local only). Release lookups default to goat-si/goat; SSH preparation fetches GOAT archives locally with gh, verifies SHA256SUMS, caches with a sidecar and uploads; missing gh/release/asset fail locally with repo/tag/asset; explicit mirrors keep the remote path; server dispatch forwards the mirror.

## Changes vs 010

- Added after review: keepExistingRunner awareness. The probe classifies a retained runner as ready (its own runtime installed, or dev runner) / missing (clear error, no gh) / none (normal acquisition). Pairing prepares without retention because it rewrites the runner. Not in 010 originally; wp4's A11 section must be stale-checked against this at wp4 P.

## Evidence

- Receipt: .codexclaw/evidence/01a12786-5623-70b0-a4cf-f235d091509e/test-receipt.json (shared 8, ssh 69, server 22, scripts 2, web 40 tests; tsc shared/ssh/server/web/scripts).
- Review: gpt-6.1-sol 01a127bc FAIL → FAIL → PASS.

## Pessimist notes (LOOP-PESSIMIST-01)

- Not improved: anonymous consumers (t3 update, pinned runtime, installers, mobile) still cannot read the private repo (D4).
- Hypothesis that died: "retargeting the release repo fixes the MacBook dispatch" — F1 shows the dispatch reuses an upstream runner in ~/.t3; the user-visible 404 persists until wp4 moves the remote root to ~/.goat.
- Refuting evidence for the direction would be: gh unavailable to the GUI-launched app (PATH/keychain) in wp5.

## Next

P for wp3 (020 MCP goat tools), stale-check 020 against HEAD fe8df0d3a (SshRemoteDispatch changed in wp2).
