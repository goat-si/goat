# 070 — Finish: rebase, fold, verify, PR

Continuation unit for the same goal after 060's hand-off. 060 left the branch pushed but without a PR and 67 commits behind `origin/dev` (`8bb1bf0b6` at planning time). This cycle set (wp0–wp4 of the continuation goalplan) takes the branch to a reviewable PR on dev. No new release features are planned; stage 4 hardening stays out of scope.

## Facts at planning time

- Branch head `8287d75c7`, 35 commits after the old merge-base, including merge `a3173a84a` (dev `034041ce4` into the branch, SSH ensure-result conflicts resolved there).
- 13 files are changed by both sides since the merge-base: `apps/desktop/src/ipc/channels.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/ssh/DesktopSshEnvironment{,.test}.ts`, `apps/server/src/sshRemote/SshRemoteDispatch{,.test}.ts`, `apps/web/src/components/settings/{SettingsPanels.tsx,settingsSearch.ts}`, `apps/web/src/connection/platform.ts`, `packages/contracts/src/{environment,ipc}.ts`, `packages/ssh/src/{tunnel.ts,tunnel.core.test.ts}`. Dev commits touching them after `034041ce4`: `7da51c258` (delegate_task on SSH hosts, SSH launches carry attachments), `8dbb71880` (launched-thread questions), `b104dc8a4`, `c23e14790`, `a564e3d02`, `e8de9f4b5`, `07eb54c5a`, `35b97310d`, `530f73960`.
- `goat/ssh-runtime-supply` (worktree `~/Developer/new/700_projects/t3code-lanes/goat-release-rename`, clean) is 114 behind / 1 ahead of dev. Everything except `a77b19874` (docs/user/remote-access.md) is already in dev. That commit says a busy server is retried "after the next app start", which this branch changes: pending replacements are retried on reconnect and every minute-scan until a 10-minute deadline, every replacement is idle-only, newer runtimes are never replaced, and a host-scope lock serializes two Macs.

## wp1 — rebase

Audit r1 (gpt-6.1-sol, FAIL) showed `a3173a84a` is not only a conflict resolution: its remerge diff also tightens the workflow guard (`.vite-hooks/goat-workflow-guard.mjs` +52/-, `scripts/goat-workflow-guard.test.ts` +55) and threads dev's key-only authentication through the pending-replacement paths (`tunnel.ts`, `tunnel.keyOnly.test.ts`, `DesktopSshEnvironment{,.test}.ts`, `contracts/src/ipc.ts`). A plain rebase would drop that content.

1. `git branch backup/release-nightly-pre-rebase 8287d75c7` (local only). Save `git show --remerge-diff a3173a84a` to `/tmp/goat-release-merge-remerge.diff` as the inventory.
2. Target tree: `git merge-tree --write-tree 8287d75c7 origin/dev`. At planning time only `packages/ssh/src/tunnel.ts` conflicts, so every other file of that tree is the exact expected end state.
3. `git rebase -i origin/dev` with the merge dropped (default). Resolve each stop toward the target tree. Immediately after the replay of `a1c764123` (the last pre-merge commit), insert one commit, `fix(release): tighten the nightly workflow guard and keep key-only auth on pending launches`, that carries the inventory's non-conflict content (guard + guard test; key-only threading where not already produced by the resolutions). Later commits then apply as before.
4. End-state check: `git diff <merge-tree result> HEAD -- . ':!packages/ssh/src/tunnel.ts'` must contain only the wp1 adaptations below; `tunnel.ts` is reviewed hunk by hunk against both sides; `git range-diff 034041ce4..8287d75c7 origin/dev..HEAD` reviewed for dropped hunks; every hunk of the inventory is present.
5. Adaptations to dev changes since `034041ce4`:
   - `apps/server/src/sshRemote/SshRemoteDispatch.ts` `preflightTarget` (dev, around :906) reads `bootstrap.httpBaseUrl` from `ensureEnvironment`; on this branch that call can return a pending-replacement result. Map it the way the launch path does (this branch :600-607) and add a pending-result test.
   - Keep dev's `revalidateTunnels`, wake IPC, attachment cleanup and launch lineage behaviour intact in `ipc.ts`, `channels.ts`, `preload.ts`, `platform.ts`.
   - Search the whole tree (not only SSH dirs) for protocol literals and old ensure-result assumptions: `SSH_RUNTIME_PROTOCOL_VERSION`, `ORCHESTRATION_PROTOCOL_VERSION`, `orchestrationProtocol`, `protocolVersion: 1`, `"2"` in fixtures, `ensureEnvironment(` consumers.

## wp2 — finish

- Fold `a77b19874` as a new commit on this branch, rewritten for this branch's behaviour (user-doc voice).
- Fix `060_handoff.md` task 11: it cites "050 §11", meaning goat_initiative `docs/050_release_channel.md` §11; write the five bootstrap steps out in the hand-off so it stands alone.
- Re-run the 060 "pre-existing failures" against the new base; fix only failures this branch causes.
- Sibling branch recommendation (report only): after this PR merges, delete `goat/ssh-runtime-supply` and remove its worktree.

## wp3 — verify (C) and review

Three separate kinds of proof, recorded separately in `evidence/finish_*.txt`:

1. Tests and static checks:
   - `vp test run scripts/goat-workflow-guard.test.ts scripts/release-verify.test.ts scripts/publish-nightly-release.test.ts scripts/prune-nightly-releases.test.ts scripts/mac-notarization.test.ts scripts/check-release-version.test.ts scripts/merge-update-manifests.test.ts scripts/build-desktop-artifact.test.ts scripts/resolve-nightly-release.test.ts scripts/lib/github-releases.test.ts scripts/lib/release-notes.test.ts scripts/lib/release-notices.test.ts scripts/lib/sea-build-path.test.ts`
   - SSH/server/desktop/client: `packages/ssh` suite; `apps/server/src/sshRemote`, `apps/server/src/cli` update tests, remote MCP/delegation tests touched by the rebase; `apps/desktop/src/ssh`, `apps/desktop/src/updates`, `apps/desktop/src/ipc/methods/sshEnvironment.test.ts`, desktop wake tests; `packages/client-runtime/src/connection`; contracts ipc/environment tests; web update/settings/connection tests.
   - `actionlint .github/workflows/goat-nightly.yml .github/workflows/goat-ci.yml`; `node scripts/check-release-version.ts`; `node scripts/resolve-nightly-release.ts` output matches `0.1.0-nightly.YYYYMMDD.N`.
   - `vp fmt --check` and `vp lint` on changed files; `tsc --noEmit` in ssh, contracts, shared, client-runtime, server, desktop, web, scripts.
2. Real archive proof: `node scripts/build-cli-archive.ts` for darwin-arm64 at a resolved nightly version (unsigned, no notarization), its smoke test, and the verifier's payload scan on the archive.
3. Manifest proof: `scripts/merge-update-manifests.ts` on synthetic arm64 + x64 `nightly-mac.yml` inputs proves only the merge (version, URLs, sizes, sha512, both architectures). The fail-closed proof uses real unsigned arm64 and x64 mac builds from this head with byte-correct merged manifests; the verifier's assemble/mac step must refuse them for missing signature/notarization, and that diagnostic is recorded apart from errors about platforms that were not built here (audit r2 finding 3).

Independent review by gpt-6.1-sol of the rebase resolutions, the inserted commit, the `preflightTarget` adaptation and the folded doc.

## wp4 — deliver

- Final `git fetch`; if dev moved, rebase again and rerun the focused checks. Push: `git push --force-with-lease=goat/release-nightly:8287d75c7 origin goat/release-nightly`.
- `gh pr create --base dev` with `Refs #1`, `Refs #2` (no closing keyword: publication and bootstrap remain human tasks), cause, fix, verification at the final SHA, unsigned/platform limits, human task list in order with exact commands, license decision, activation facts, and model/harness attribution.
- Activation facts for the merge thread: `goat-nightly.yml` listens for completed goat-ci runs on dev, but GitHub reads `workflow_run` and `workflow_dispatch` definitions from the default branch `main`. Merging into dev therefore starts nothing. Actions is enabled for the repository and a newly added workflow is active by default, so the first promotion that puts the file on `main` turns it on; unless the human tasks are done by then, disable it right after that promotion (`gh workflow disable goat-nightly.yml --repo goat-si/goat`) or switch it on deliberately.
- `link_pull_request`; `goat_thread_send` to `mcp:b2019de5-375d-4f63-87b4-c14bd804e935`; `goat_origin_report`.

## Decisions only humans can take (recorded, not blocking the PR)

- Binary license terms for goat-releases before the first publication (goat-releases intentionally has no LICENSE; only upstream MIT notice and third-party notices ship).
- All 060 tasks: keychain identity, `goat-notary` profile, Rust, preflight, runner registration, GitHub App + secrets, protected tags, runner-boundary acceptance on the free plan, activation on main, first publication, bootstrap.
