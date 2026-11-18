# next3 K3 · branch-only Git subscriptions

C4 wire-contract port for integration PR #3700. Lane base `f82d2df4b0`. Port in upstream ancestry order: `0d809db501`, `0ceaa9a48c`, `0ac41eecad`, `76e4cb5c8a`, `a3477a5dd93`.

## Compatibility and verification plan

- The descriptor's optional `vcsBranchStatus` capability opts a socket session into `subscribeVcsBranch({ cwd })` and `vcs.refreshBranch({ cwd })`. Keep the current status RPCs and payloads so older clients retain local and remote status. The new methods use the corresponding status scopes. Test denial and an old-client status call against the new server.
- With an older server, project branch labels from `subscribeVcsStatus({ cwd, includeRemote: false })` and skip branch refresh. Negotiate against the same session that executes the call. Reconnect through K7's subscription lifecycle, reevaluating capability on the replacement session. Cover mixed versions and reconnect in client-runtime tests.
- Web sidebar and search rows use branch-only leases, and mobile Branches uses the branch stream. Detailed Git surfaces retain full status. Branch-only demand must perform zero detailed reads and remote polls. Preserve GOAT's remote cache and auto-pull guards. An optional `isRepo` keeps ref-only messages decodable. Only explicit false clears the sidebar presentation of persisted branch and worktree labels, leaving persisted data intact.
- Resolve linked-worktree HEAD through GitWorkflowService. Share one scoped directory watcher per normalized checkout and refresh on atomic HEAD replacement. Stop when the Git admin directory disappears. Test shared teardown, index-lock recovery, PR cache consistency, no fetch/auto-pull, and the exact missing-repo payload. PR #3700 Windows CI must show that worktree removal during HEAD.lock churn emits missing-repo status and stops the watcher without spinning.
- Publish the fast HEAD read ahead of the detailed read. Exercise an in-flight slow status operation and check branch subscribers still get the latest HEAD.
- Run whole changed test files (server with `GOAT_TEST_TMP_GUARD=fail`) and `vp run check:changed origin/chase/t3-261114-next3` on Node 26.12.1 after integrating the latest base once. Live-client and hosted Windows proof belong to the integration pass. No dev server in this lane.

## Port disposition

| Upstream | GOAT commit | Disposition |
| --- | --- | --- |
| `0d809db501817356882ed4a2d79b3f2d52f515f1` | `93575905ea8f13723d079f50856742be23f6ecfd` | Adapted. The existing status scope and routes still serve older clients. K7's reconnect pipeline chooses the branch stream or local-only fallback for each session. GOAT's web leases and wake helper, mobile Branches, and remote cache guards stay in their existing paths. |
| `0ceaa9a48ca6448caf5fb5b2e3d00bb1a92a1c60` | `fd782da8fd92d678b991540f558828d1f3d88d65` | Adapted. Git resolves each worktree's HEAD in its own admin directory. A scoped watcher serves the normalized checkout, and detailed reconciliation reuses GOAT's cache and no-fetch path. Existing tests moved where needed to fit the line caps. |
| `0ac41eecadd4c8e358506471219aa83391a4f2db` | `a113951aef8c77a3d3d2bd9b1bbd29d8d2085ac1` | Adapted. Explicit false clears the main/sidebar search tooltip and row's worktree indicator. The stored thread retains branch and worktree. Absent isRepo and detached HEAD preserve labels. |
| `76e4cb5c8af631c920bad9202436348bf4d5b50f` | `20e59503b066e2cb1342235299cb971875042ced` | Adapted in the extracted watcher. The terminal removal event triggers one last refresh even if the OS reports the directory or HEAD.lock instead of HEAD. The test asserts the missing-repository payload and scope closure. |
| `a3477a5dd93b34b4508784382ffad5ae698c6fde` | `1929fc442874be9a2c3b6eace461d3eb71ef9e4e` | Adapted. Fast HEAD publication precedes pending status work. Read observations fence stale detail results. Branch listeners have separate bounded buffers per checkout, and explicit refreshes coalesce pending detail reconciliation. |

The WorktreeBranchSync rows `0cb9328ea00` and `ad1b1365999` are outside K3. No issues were filed. K7's exported `requestInSession` won the integration conflict, and both branch operations negotiate on the session that executes them.

## Test expectation changes

The two pre-existing mobile sheet tests use upstream's corresponding mock substitution in `0d809db501`: `vcsEnvironment: { status: () => null }` → `vcsEnvironment: { branch: () => null }`. Their assertions are unchanged. The tests added earlier in this lane pick up upstream `0ac41eecad` expectations such as `[{ refName: "main" }]` → `[{ refName: "main", isRepo: true }]` and `[{ refName: null }]` → `[{ refName: null, isRepo: false }]` for deletion. The detached branch case expects `isRepo: true`. The pre-existing broadcaster test moved with its assertions intact. The import missed during that move was restored in the next row.

## Integrated P1 rows

- On web and desktop, lease a visible sidebar row and open search for a scratch checkout. Switch branches in the terminal, detach HEAD, then remove a linked worktree. Verify that status arrives without opening a Git panel, detached HEAD retains stored labels, and removal clears the branch and worktree presentation. Reopen the thread to confirm the persisted worktree metadata still exists.
- In mobile Branches, switch the checkout outside the app and check the selected branch. Reconnect the client to a host without the capability and confirm the legacy status projection. With the current host, hold detailed status work pending and check that the sidebar/search branch update arrives first.
- For PR #3700 on Windows, explicitly include `apps/server/src/vcs/VcsStatusBroadcaster.watch.test.ts` and `apps/server/src/git/GitWorkflowService.test.ts`. `WINDOWS_SUITES` does not currently select these paths. The Windows proof must show atomic `HEAD.lock` rename still updates a linked checkout, ordinary lock churn leaves its watcher alive, and removal during churn produces `{ refName: null, isRepo: false }` and closes the directory watcher without a continuing event loop, Git reads, or a server hang. The synthetic removal test checks payload and closure, while native churn still needs Windows evidence.

NOT RUN: PR #3700 CI and native Windows churn, integrated live web/desktop/mobile P1, independent C4 review, repo-wide gates, lane CI, a new PR, and WorktreeBranchSync.

Source anchors on the lane head:

- Session-scoped branch fallback and refresh in `packages/client-runtime/src/rpc/client.ts:767`.
- Checkout invalidation and split HEAD/detail work in `apps/server/src/vcs/VcsStatusBroadcaster.ts:687`, and watcher closure in `apps/server/src/vcs/headWatchers.ts:70`.
- Branch selection and label presentation in `apps/web/src/components/sidebar/useSidebarBranch.ts:15` and `:36`.

## Earlier verification

- The initial changed-files run was interrupted with exit 130 after typecheck reported watcher event inference errors. The integration merge was amended with the type corrections, direct refresh authorization coverage, and keyed watcher teardown.
- The next full gate on `d185c5fd2c64f2bf5c4ffa94b1061491ab57a849` exited 1. Static checks passed, with 4,855 server tests and 3,899 workspace tests passing. The existing `apps/web/src/state/vcs.test.ts` failed before running its assertion because the shared state module initialized a new sidebar-only atom using a mocked export. Standalone `vp test run apps/web/src/state/vcs.test.ts` reproduced the import failure. Moving the wake atom into its owning sidebar hook restored the state module to the integration tree. No test or expectation changed in the correction, and no server or shared-package file changed from the previous gated head.
- On `16806c18cc27b153d3bc1a3a7d2f31f189cf7c7f`, the existing web state test, sidebar labels, and Chromium sidebar render isolation passed together (3 files, 4 tests). The guarded whole-file run included all 12 changed test files plus the existing state and browser regressions (14 files, 146 tests, exit 0).

## READY

Lane branch `chase/t3-261114-next3-k3` was plain-pushed and its remote head verified at `16806c18cc27b153d3bc1a3a7d2f31f189cf7c7f`. The single integration merge has parent `061fd0fee904c2abaada9efb5cfdb9ea58b18919`, the merge base used by the gate. After the gate ended, `git merge-tree --write-tree HEAD 9af811b8fc3d2fc0039efbafee606ca358d5a490` exited 0 against the current integration tip. The dry merge was a conflict check. Verification ran on the lane head.

- Node `v26.12.1`. `vp run check:changed origin/chase/t3-261114-next3` exited 0 for 35 changed files. Rename scan, formatting, lint, both Knip checks, server GraphQL, agent surface audit, agent context budget, and typecheck of 38 packages passed.
- The gate selected 399 test files and finished in 3058.7 seconds. Server batch: 363 passed files, 2 skipped files, 4,855 passed tests, 4 skipped tests. Workspace batch: 34 passed files and 3,810 passed tests. Total: 397 passed files, 2 skipped files, 8,665 passed tests, 4 skipped tests, zero failures. The existing skips came from the memory growth suites and `src/cloud/autoUpdate.test.ts`.
- Guarded whole-file run: `GOAT_TEST_TMP_GUARD=fail vp test run <12 changed test files> apps/web/src/state/vcs.test.ts apps/web/src/components/Sidebar.renderIsolation.browser.test.tsx`, exit 0, 14 files and 146 tests, zero failures or skips.
- `git diff --check HEAD^2...HEAD` exited 0. The worktree was clean at handoff.
