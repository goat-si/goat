# 050 — Cycle records

## wp0 (roadmap) — D

Conclusion: the roadmap for stages 1–3 plus the runner kit is written to diff level and passed a four-round audit by gpt-6.1-sol (002). Measurements so far: a gui-domain LaunchAgent can read the login keychain and reach notarytool profiles; a Background session cannot (001 M1). Rosetta, Xcode and Rust are absent on this Mac (M2). Commit `eb83ae52b`.

Did not improve / died: the 050 plan to modify and reuse upstream `release-desktop.yml` died (N-1). The assumption that `workflow_run` works with dev as base died: the default branch is `main` (N-3). The first SSH and updater sketches were too thin to implement (r1 blockers 5–8); the lane designs replaced them and are larger than the "smallest model" ideal — wp3 must watch scope.

Refuting evidence to watch: if wp4 shows the x64 DMG cannot be built or its native modules are arm64, N-5's "both DMGs on Mac Studio" falls back to the 040 alternatives.

Next: wp1 (010), starting with a stale check of its anchors.

## wp1 (foundation) — D

Conclusion: GOAT is 0.1.0; nightlies resolve to `0.1.0-nightly.YYYYMMDD.N` named "GOAT Nightly"; every release consumer points at goat-si/goat-releases; goat-ci checks the release manifests; the pre-push guard accepts only a gated `goat-nightly.yml`; LICENSE-T3CODE.txt ships in apps and CLI archives; `THIRD_PARTY_NOTICES.md` can be rendered from the web license manifest. Commit `7dd7c6f55`.

Evidence: receipt `.codexclaw/evidence/01a12c06-25d3-7e51-a389-4b9056110c41/test-receipt.json` — `check-release-version: ok`, actionlint goat-ci.yml clean, 12 test files passed and 2 Windows-only installer files skipped on macOS (425 tests), tsc clean for scripts/shared/ssh. Micro-audit (gpt-6.1-sol) NEAR-PASS, residuals folded.

Deviations from 010: `check-release-version.ts` drops the desktop app regex import (cross-package file outside the scripts tsconfig) — the feed and CLI rules cover the same pattern; it is written in the Effect CLI style the scripts lint requires. Added `.github/actionlint.yaml` for self-hosted labels. Commits under `devlog/` need `--no-verify` because lint-staged cannot re-stage files ignored by `.git/info/exclude` (only the formatter hook is skipped; files are formatted first).

Did not improve: `release-smoke.ts` was edited but not run (it reinstalls in a temp copy); wp4's dry run covers the resolver path. AUR packaging still points at goat-si/goat (out of scope).

Next: wp2 (020).

## wp2 (pipeline) — D

Conclusion: `goat-nightly.yml` (gated, job-level cancellation, Mac Studio signing jobs, hosted/EPYC builds, assemble, publish-only secrets) plus the scripts it calls are in place: Mac runner preflight, keychain-profile notarization for desktop and CLI (require mode, whole-payload submission, Accepted check), DMG finalize, verifier (payload/mac/assemble, report gate with DMG transforms), publish (idempotent, byte-verified, monotonic, superseded before any write to main) and prune. HEAD `8ee9b5822`.

Evidence: receipt `.codexclaw/evidence/01a12c06-25d3-7e51-a389-4b9056110c41/test-receipt.json` — actionlint (goat-nightly, goat-ci), preflight syntax, 12 test files / 289 tests, scripts tsc, lint scripts + .vite-hooks. Review: Claude Sonnet r1 FAIL (2 blockers: Linux x64 artifact names, verifier keys) → r2 NEAR-PASS (2 small findings) → all fixed. Local dry run (`evidence/dryrun_r3_chain.txt`, `m3_x64_cross_build.md`, `m1b_preflight_sessions.txt`): arm64 and x64 DMGs build unsigned on this Mac (38 s / 52 s) with clean builder payload reports and the feed set to goat-releases; unsigned DMGs are refused by assemble (fail-closed); a real darwin-arm64 CLI archive builds, passes its smoke test and payload scan; assemble writes SHA256SUMS; publish and prune dry runs plan against goat-releases read-only.

Found only by the real build (unit tests passed): the exposure scan flagged third-party code (node_modules TypeScript, native binaries' CI paths, Electron's inline map) — the rule now targets GOAT code plus this machine's paths everywhere; and the Node SEA blob embedded the checkout path (`.../apps/server/dist-exe/bin.mjs`) — `build-cli-archive` now rewrites the checkout root to a same-length neutral path before signing, and the smoke test still passes.

Deviations from 020: Linux x64 desktop joined the `desktop_other` matrix (runner arrays are allowed in matrix rows); EPYC rows keep `dtolnay/rust-toolchain` (cargo not guaranteed there); preflight moved from wp4 into wp2 because the workflow calls it; `render-third-party-notices.ts` added for assemble; verifier `--key` values follow the verifier's own naming (`cli-<platform>-<arch>`, `desktop-mac-<arch>`).

Did not improve / unverified: no real Developer ID signature, notarization, stapling or spctl run (identity and profile not installed — user tasks); Windows/Linux jobs never ran (hosted runners, no workflow execution allowed); x64 binaries cannot execute here (no Rosetta). The unused other-arch `objc-js` prebuild ships in both mac apps (harmless, optional cleanup).

Next: wp3 (030).

## wp3 (wiring) — D

Conclusion: the app downloads nightlies automatically and restarts to install when every backend reports idle (policy `restart-when-idle` default, `install-on-quit`, `paused`; durable pending record; settings row and search entry). SSH runtimes come from goat-releases over HTTPS with SHA256SUMS before the gh fallback, every replacement is idle-only and never downgrades, a host-scope symlink lock with locale/TZ-independent dead-owner proof serializes replacement, and pending replacement intent survives reconnects and retries every minute-scan up to its own deadline. Both protocol constants are 1001 (0.0.45 servers read as "needs a newer server"). `goat update` listing retries and caches. Commits from `fe3c5c893` to `c767da4b4`.

Evidence: receipt `.codexclaw/evidence/01a12c06-25d3-7e51-a389-4b9056110c41/test-receipt.json` (`/tmp/goat-wp3-check.sh`): full `@t3tools/ssh` suite 21 files / 438 tests; server CLI/SSH/desktop-update, client-runtime connection, contracts, shared, desktop updates/settings/lifecycle/ssh, web connection/update/settings: 237 files / 3451 tests; `tsc --noEmit` clean in ssh, contracts, shared, client-runtime, server, desktop, web, mobile, scripts. Reviews (Claude Sonnet): updater FAIL (3 blockers) → PASS; SSH FAIL (3 blockers: locale-dependent lock owner, lost uninterruptible close, placeholder intent changing disconnect stop) → PASS.

Integration finds (main agent): lane R's tests assumed protocol 1/2, so combining R with P broke 10 SSH tests (fixed in `3920084ab`); `scripts/lib/*.test.ts` importing `scripts/*.ts` broke the desktop project's typecheck (tests moved to `scripts/`); the new update-state fields needed decode defaults so reports from older desktops and servers still decode, and the persisted record keeps its own schema without the wire default.

Deviations from 030: WSL backends stay "unknown" (restart postponed) as designed; retries scan every minute and honor each intent's 10-minute deadline; a stale recovery lock surfaces as `recovery-stale` with the manual-removal hint.

Did not improve / unverified: no real SSH host, two-Mac convergence or electron-updater install ran (needs published nightlies and the bootstrap, 050 §11); the probe-to-stop race and older clients ignoring the remote lock remain (bootstrap quits both old apps first). Pre-existing, unrelated: `DesktopApplicationMenu.test.ts` expects "goat (Nightly)" while the app name has been "GOAT" since `b79ff462c`; desktop tests are not in goat-ci.

Next: wp4 (040).

## wp4 (runner, measurements, delivery) — D

Conclusion: the Mac runner kit (`preflight.sh`, `install-runner.sh`, `docs/operations/goat-mac-release-runner.md`) and the user documentation are in place; dev was merged into the branch with the SSH conflicts resolved; the final cross-family review of the main agent's own code found and fixed guard false negatives (bracketed or whitespace-prefixed secrets, an aliased publish job, an unbound prepare output) and false positives. User tasks and risks: `060_handoff.md`.

Did not improve: nothing ran on a real runner, App or notary service; the guard remains advisory on the free plan.

Final review (gpt-6.1-sol, six rounds on the main agent's own code, chiefly the workflow guard): r1 FAIL (bracketed/whole-context secrets) → r2 FAIL (whitespace before secrets) → after the dev merge, r1' FAIL (aliased publish job, unbound prepare output) → r2' FAIL (quoted "}}", expression keys, forged resolver) → r3 FAIL (inherited default shell) → r4 FAIL (partial expression wrapper, skippable resolver) → r5 FAIL (prepare checkout after a failed resolver) → r6 NEAR-PASS: no confirmed bypass of rules 1–7. Accepted residual: any string containing an expression and the word "secrets" is refused outside publish (conservative false positive; precise expression parsing kept producing bypasses). The resolve step is pinned by hash, so editing it needs a matching pin update in `.vite-hooks/goat-workflow-guard.mjs`.

## Continuation wp0 (finish roadmap) — D

Conclusion: `070_finish.md` plans the rebase onto dev `8bb1bf0b6`, the fold of `goat/ssh-runtime-supply`'s only unmerged commit (`a77b19874`), the three local proofs and the PR. Audit gpt-6.1-sol r1 FAIL → r2 NEAR-PASS.

Did not improve / died: the first plan treated merge `a3173a84a` as pure conflict resolution; its remerge diff also carries guard tightening and key-only threading, so the rebase inserts that content as its own commit. The idea that assemble produces merged manifests died: `merge-update-manifests.ts` merges, assemble only validates.

Next: wp1 (rebase).

## Continuation wp1 (rebase) — D

Conclusion: the branch is a linear rebase on dev (`8bb1bf0b6`, then `19327628e` before push) with no merge commits. The old merge's extra content became its own commit (guard tightening + key-only test narrowing). The only real conflict was `ensureTunnelEntry` in `packages/ssh/src/tunnel.ts`: a healthy tunnel with no pending replacement goes through dev's `keepAnsweringTunnel` (wake fix), a tunnel that needs replacement keeps the branch's probe + `createTunnelEntry({ previous })` path, signature `(key, target, runner, background = false, keyOnly = false)`. Adaptations to dev: `preflightTarget` (SSH workspace sync) maps a pending runtime to `host_unavailable` like launch and tool calls; dev's sleep-revalidation test uses the ready launch output; a desktop pending test stub gained `revalidateTunnels`.

Evidence: end state equals `git merge-tree 8287d75c7 origin/dev` except the tunnel conflict region and the adaptations above; receipt (`/tmp/goat-wp1-check.sh`): 9 typechecks clean, 271 test files / 4147 tests passed.

Did not improve / died: the earlier sketch "rerere will replay the merge" died — rerere recorded preimages but the linear replay met different hunks, so resolutions were written by hand from the old merge's text.

## Continuation wp2 (finish) — D

Conclusion: the only commit of `goat/ssh-runtime-supply` not in dev (`a77b19874`, docs/user/remote-access.md) is folded and rewritten for this branch; the same paragraph block also dropped the stale "download needs gh" claim. The hand-off now carries Activation, a standalone Bootstrap and the license decision (task 13).

Recommendation for the sibling lane: after this PR merges, delete branch `goat/ssh-runtime-supply` and remove the worktree `~/Developer/new/700_projects/t3code-lanes/goat-release-rename` (clean, nothing else unmerged).

Pre-existing failures re-checked on the new base: `DesktopApplicationMenu.test.ts` now passes; `apps/server/scripts/migrate-dev-db.test.ts` (snapshot phase) and `apps/mobile/scripts` (Swift `Mutex` unavailable) still fail for environmental reasons; the branch touches no migration, mobile or `.github/scripts` file.

## Continuation wp3 (verify) — D

Conclusion: local proofs pass — release script tests (14 files / 318 tests), actionlint, version check and resolver, fmt and lint on all 163 changed files (no warning on a branch line), typechecks; a real darwin-arm64 CLI archive with smoke test and payload scan; unsigned arm64 and x64 DMG/ZIP builds whose merged `nightly-mac.yml` matches the files byte for byte and whose app points its feed at goat-si/goat-releases; the CLI notarization gate, the mac signing gate and assemble all refuse unsigned output (`evidence/finish_archive_manifest.md`). Review gpt-6.1-sol (high) r1 NEAR-PASS → r2 NEAR-PASS, only doc findings, all folded.

Did not improve: nothing ran with a real Developer ID, notary profile, Windows/Linux runner or goat-releases write; the x64 app cannot be launched here (no Rosetta). Local lint carries a decoder-hoist fix in this branch's own test.
