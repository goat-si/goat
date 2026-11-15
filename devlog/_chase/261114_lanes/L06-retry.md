# L06 retry: project and source control fixes (chase cycle 261114)

Lane branch `chase/t3-261114-scm-retry` (head `c987c45a81`), merged with `origin/chase/t3-261114-all` for hand-over. No pull request: the catch-up lands as #3397. This lane decides 22 upstream commits and ports 20 of them (19 adapt, 1 take); 2 are deferred. Each port's commit message names its upstream commit and decision. Lane review of `9dfe33f115`: approve with nits on the ports, with two P2 findings that the fix round below settles.

## Decisions

Counts: 20 ported (adapt 19, take 1), 2 deferred (1 design question, 1 missing in-range predecessor). Deferrals are tracked in #3176.

| upstream | decision | GOAT commit | reason |
| --- | --- | --- | --- |
| `81c3da3856` removed thread worktrees keep their project's skills in the picker (#32471) | adapt | `497451ebff` | |
| `bbd51f74b4` import Codex chats moved into a project from the scratch folder (#32880) | adapt | `8c8dc5cc24` | |
| `c82e1ba515` GitLab review comments can cover a range of lines (#30535) | adapt | `3c36b316b9` | |
| `37452eeaa3` cloning into a stranded clone project's empty folder reuses that project (#33439) | adapt | `b54d958b41` | C4 contract, below |
| `362ef9a88a` GitLab: revert a merged merge request (#30556) | adapt | `5261d13fd3` | C4 permissions, below |
| `23132f8338` pull requests missing refs/pull/N/head no longer show as not found (#25947) | adapt | `db451b4dbc` | |
| `46002808e2` find pull requests for SSH aliases (#32932) | take | `5a941c6c7d` | |
| `10128e5925` repeated session imports reach transcripts behind the scan budget (#27215) | adapt | `fc5b8fe9d4` | |
| `c501ccad57` PR watch waits for queued GitHub workflow runs (#34624) | adapt | `9e6fa22993` | |
| `4ff329d108` fork PRs into gh's upstream base use an owner-qualified head (#35055) | adapt | `21432061ef` | |
| `41156481b1` a folder that only holds a repository's worktrees is refused as a project (#36366) | adapt | `88b6aa58f6` | |
| `d46b90c634` the Welcome page offers repositories you only worked on in worktrees (#33923) | adapt | `e39f72c7e9` | |
| `a1e0e507e1` status refresh on a fork's default branch is 2.5x faster (#33954) | adapt | `0260cd05db` | |
| `dbaef808d5` wake PR watches when the merge queue drops a pull request (#24141) | adapt | `c865238b1e` | C4 contract, below |
| `f59aa4eba0` reject PR watches when hosting dependencies are unavailable (#33389) | adapt | `a4b38b0204` | C4 permissions, below. Refused: agents and scheduled tasks registering a watch through the MCP pull request tools. Web and mobile watch toggles are not refused, and an existing watch is never dropped. |
| `5e18314b88` Forgejo: fast-forward-only repositories can merge pull requests (#32738) | adapt | `7beb1754e1` | C4 contract, below |
| `2432ee10c6` blocked pointer-file scan test waits for the unblocked read (#36031) | adapt | `30f187f256` | test only |
| `9b6dde9a23` session import finds compressed Codex rollouts (#34947) | adapt | `d6b73cd03a` | |
| `2d5e0ae2bd` session import brings in the linked-worktree sessions the Welcome page counts (#36242) | adapt | `176ed9d206` | C4 data loss fixed in `08d6d68b3d` and `42d93c89ef`, below |
| `4596872940` linked-thread counts update when links change instead of polling every 10s (#35865) | adapt | `891349df0c` | C4 contract, below. `0a6c3427f4` coalesces the refresh signals per subscriber. |
| `4e1be34436` watched GitHub pull requests react to host events, not only the 2-minute sweep (#33548) | deferred: design question | | Its predecessor `0c80751701` (sign in through the GitHub App) was skipped, and the event feed needs that credential: GOAT's GitHubRest.credential takes only a host (packages/source-control-github/src/server/GitHubRest.ts:51). Design settled for the port (option A): event-driven reads obey each group's read backoff, and a failed event read counts toward READ_FAILURE_LIMIT (apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:53). |
| `e0d6aadb88` watched GitHub pull requests react when a check suite completes (#35709) | deferred: missing in-range predecessor | | Needs `4e1be34436`: its GitHub event module (gitHubPullRequestEvents.ts) is absent from packages/source-control-github/src/server/. |

Moves came before ports whose files were near their code budgets, each in its own commit. Most change only exports and imports. Four add structure: `fabe7b4e97` wraps the moved transcript discovery in a `makeTranscriptDiscovery` factory, `86060e7b8c` copies the `isGraphQlClientError` helper into the new module (the original stays for its other caller), `faefdf8846` wraps the moved test in an `it.layer` and `describe` block, and `33a35a8122` groups the pull request method names in `PULL_REQUEST_WS_METHODS` and spreads it back into `WS_METHODS`. The last move (`910a7a6b51`) came after the first hand-over merge: merging put ProviderRegistry.ts at 1020 lines against its 1017 budget.

## C4 cases

- `2d5e0ae2bd` (data loss, found in review): an imported session's linked worktree became its thread's worktreePath, and deleting that thread on web or desktop offered "Delete the worktree too?", whose yes ran `git worktree remove --force` on the user's own checkout. Now `vcs.removeWorktree` refuses any folder outside GOAT's worktrees folder with a GitCommandError, so an older client that still asks gets the refusal and nothing is removed. `orchestration.getWorktreeThreadIds` adds `managed`, and web and desktop offer the removal only when it is true; a newer client against an older server, which omits it, offers nothing. `goat_worktree_remove` by threadId and `goat_worktree_cleanup` refuse a worktree outside GOAT's worktrees folder even when a thread points at it; removal by an explicit path is unchanged. Mobile never offered the removal. Storage cleanup on delete, archive and settle already kept such folders ("outside the managed worktree folder"), and `goat_thread_delete` removes no worktree. A GOAT-made worktree is offered and removed as before. The imported thread keeps its worktreePath so its turns resume in that folder.
- `362ef9a88a`: reverting needs GitLab's `can_merge`, the permission that also gates merging (packages/source-control-gitlab/src/server/GitLabPullRequestProvider.ts:58). An unmerged merge request or one with several commits and no merge commit is refused before any write. A revert branch is deleted if the revert or the merge request creation fails or is interrupted.
- `37452eeaa3`: an older server always returns the requested project id, so newer web and mobile clients behave as before against it. An older client against a newer server differs only when a stranded clone project owns the empty folder: the server now starts the clone for that project where it used to refuse with a conflict, but the client follows the id it sent, which never appears, so it opens that missing project and drops the ignored-file copy (addProjectToMachine waits for a clone under the requested id). The clone itself lands in the existing project, which the sidebar shows.
- `dbaef808d5`: a pull request and a saved watch from before the new field still decode, and an older peer drops the new keys. A blank removal id is rejected. A removal made by merging, or one older than the watch, does not wake it.
- `f59aa4eba0`: watching is refused when the host's CLI is missing, and unwatching still works. Watching a merged PR is refused. `watch_pull_request` returns the error and saves nothing. The command and stored data are unchanged, so older peers see no new shape.
- `5e18314b88`: an older server's merge options read as "no fast-forward", an older peer drops the new key, and an older server refuses a fast-forward merge request instead of merging another way. `autoMergeMethod` on a pull request's summary and detail now reads an unknown method as absent (`edbcc84ef3`), so a method a newer host adds cannot fail a client's whole detail or list.
- `4596872940`: an older server's capabilities read as not signalling linked-thread changes, and the client polls it without calling the new stream method. An older peer drops the new `linkedThreadRefreshes` key. A non-boolean value is rejected. `pullRequests.subscribeLinkedThreadRefreshes` refuses a session without orchestration read.

## Known limits

- `4596872940`: the change detector keeps side chats, because GOAT's linked-thread query lists them (upstream's excludes them).
- `2d5e0ae2bd`: GOAT's Codex history-thread imports take the worktree of their candidate's cwd, since a history thread has no transcript cwd. A GOAT test covers this.
- `dbaef808d5`: a merge queue removal follows the project's failed-check mode (react, keep as context, or ignore). Upstream has no such setting.
- Worktree removal from the thread delete prompt needs a server with `managed` in `getWorktreeThreadIds`; against an older server, newer clients keep every worktree.

## Surfaces

- Server: every row.
- Web: `37452eeaa3` (follow the returned clone id), `5e18314b88` (Fast-forward merge in the merge-method menu, saved as the last-selected preference), `362ef9a88a` and `c82e1ba515` through the existing Revert and range-comment controls on GitLab, `d46b90c634` (more repositories on the Welcome page), and the delete-thread worktree offer.
- Mobile: `37452eeaa3`, `5e18314b88` (the merge-method choice in pull request actions, saved as a preference). Linked-thread refreshes (`4596872940`) reach web and mobile through the shared client runtime. Mobile has no worktree removal on delete.
- Desktop: no change beyond web.
- Agents and MCP: `f59aa4eba0` (`watch_pull_request` refuses when the hosting tool is missing), revert (`362ef9a88a`) and fast-forward (`5e18314b88`) through the pull request action tools, and `goat_worktree_remove` and `goat_worktree_cleanup` keeping worktrees GOAT did not make. The agent surface audit counts the new error tag.
- Providers: GitHub, GitLab, and Forgejo rows as named. No agent provider adapters change.

## Captures

Harness renders: the browser-test harness with the app stylesheet and fixture data, made by temporary capture tests that were not committed. No real forge accounts.

- Merge-method menu offering Fast-forward merge (Forgejo fixture): [light](https://raw.githubusercontent.com/goat-si/goat/02e340e3efb28adb99a9fc7649bd36360919ab65/3397/l06retry-harness-merge-methods-fast-forward-light.png), [dark](https://raw.githubusercontent.com/goat-si/goat/02e340e3efb28adb99a9fc7649bd36360919ab65/3397/l06retry-harness-merge-methods-fast-forward-dark.png)
- Revert changes on a merged GitLab merge request: [light](https://raw.githubusercontent.com/goat-si/goat/02e340e3efb28adb99a9fc7649bd36360919ab65/3397/l06retry-harness-gitlab-revert-merged-light.png), [dark](https://raw.githubusercontent.com/goat-si/goat/02e340e3efb28adb99a9fc7649bd36360919ab65/3397/l06retry-harness-gitlab-revert-merged-dark.png)
- Welcome page repository list: [light](https://raw.githubusercontent.com/goat-si/goat/02e340e3efb28adb99a9fc7649bd36360919ab65/3397/l06retry-harness-welcome-repositories-light.png), [dark](https://raw.githubusercontent.com/goat-si/goat/02e340e3efb28adb99a9fc7649bd36360919ab65/3397/l06retry-harness-welcome-repositories-dark.png)

Mobile: not captured. No render harness exists for the React Native pull request actions, and a device run needs a real forge account.

## Hand-over merges

- `a49d76548f` merges `origin/chase/t3-261114-all` at `56421003ff`. Conflicts: ProviderRegistry.ts keeps the integration branch's scan-base snapshot and this lane's `scanCwd`; environment.test.ts keeps both sides' capability tests.
- `d80fce1849` merges `origin/chase/t3-261114-all` at `24c7a4e0da`, then `952a4a2c89` at `bd69c4db0b` (#3207 and #3209 provider environments), `751874d64b` at `83138ac3b6` (#3208), `7b5fbf8bad` at `428af27456`, `d28ce505bc` at `1f34e35e42`, and `c987c45a81` at `3f9cb15cba`. No conflicts, and budgeted files stay within their entries: ws.ts 3612 of 3612 (this lane's `97f3444175` moved the workspace failure contexts out of it), orchestratorMcp.ts and runtimeLayer.test.ts untouched by this lane. No lane commit reads or keeps a provider environment, so the provider environment rule from #3207, #3208 and #3209 has nothing to apply to here.

## Fix round after review (on `9dfe33f115`)

- `42d93c89ef` worktree cleanup and removal by thread never take a checkout GOAT did not make.
- `08d6d68b3d` deleting a thread never removes a worktree GOAT did not make (server refusal, `managed` flag, web and desktop offer).
- `776f0c07ac` user docs: an imported worktree stays; GitLab can open a revert (docs/user/source-control.md).
- `0a6c3427f4` archiving many linked threads sends each open pull request list one refresh: `subscribeLinkedThreadRefreshes` keeps the newest revision in a sliding buffer of one per subscriber.
- `edbcc84ef3` `autoMergeMethod` reads an unknown method as absent; GitHubPullRequestApi.test.ts budget lowered from 3583 to 3582.
- `d0e5fcb572` types the new RPC test's mocks.
- `1ce0767b31` user docs: deleting the thread or cleaning up worktrees leaves an imported worktree in place.

## Tests

Fail-first this round, each run on the base before its fix:

- Worktree inventory: "a thread pointing at a checkout outside GOAT's worktrees folder never gets it removed" failed (removal by threadId with force deleted `…/user-checkout`); with only the sweep change reverted it failed with `expected [ {…} ] to deeply equal []`. Then WorktreeInventoryService.test.ts passed 32 of 32.
- RPC boundary (ws.lifecycle.test.ts): an older client's `vcs.removeWorktree` for a folder outside the worktrees folder reached git removal (`expected [ '/private/tmp/…/user-checkout-…' ] to deeply equal []`); then 5 of 5 passed, including the managed folder still being removed.
- Web delete flow: the two no-offer cases (unmanaged, and an older server without `managed`) failed with the confirm called once; then 70 of 70 passed across the three useThreadActions test files.
- Linked-thread refreshes: a busy subscriber received all 10 revisions (`expected 10 to be at most 3`); then passed, three runs in a row.
- `autoMergeMethod`: decoding a detail with an unknown method threw `Expected "merge" | "squash" | "rebase" | "fast-forward"`; then pullRequest.test.ts passed 14 of 14.

Earlier rounds' fail-first evidence:

- `9b6dde9a23`: 2 failed before (`expected []`), then 100 passed across the scanner and importer files.
- `2d5e0ae2bd`: 3 failed, 14 passed with the source change stashed, then 102 passed.
- `4596872940`: 7 failed, 91 passed before (the service test timed out because no refresh was signalled), then 195 passed across 11 files. The full runtimeLayer.test.ts passed 171 of 171.
- Run 3: `a1e0e507e1` 2 failed, then 165 passed. `dbaef808d5` 11 failed, then 423 passed. `f59aa4eba0` 4 failed, then 209 passed. `5e18314b88` 4 failed, then 37 passed. `2432ee10c6` 66 passed (test only).

Gate on the lane head `c987c45a81` (`3f9cb15cba` merged), run by the coordinator on pen-macbookair (macOS 26.6.2, 10 cores, load 4 to 7), since pen-macbookpro2 never went quiet: `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed` with pipefail. Verdict: pass after triage. Every static step passed, including typecheck (42 packages) and the agent surface audit. Tests: 2049 of 2063 files and 29257 of 29359 tests passed. No failure comes from this lane:

- SshWorkspaceSync, 44 failures: passes alone (84 of 84), goat#3417.
- launchListenerScripts: passes alone, goat#3403.
- packages/ssh runtimeFactsScripts.test.ts: macOS /bin/bash 3.2, goat#3363 (the same on `3f9cb15cba`; it also failed on pen-macbookpro2 in the earlier round).
- tunnel.client-session: goat#3418, the same on the tip.
- GrokTextGeneration, 16 failures: goat#3425, the same on the tip.
- cli/app.test.ts, 4 relative-cwd assertions: goat#3238, the same on the tip.
- FcmDeliveries, 2 tests: NOT RUN, no PostgreSQL on that host.

On pen-macbookpro2 the same head's static steps passed in two earlier local runs, which were stopped before their test step when a new tip arrived or another lane's gate ran. Focused tests on `c987c45a81`: 9 files, 133 passed. `vp run agent-surface:audit` rewrote docs/internals/agent-surface-audit.md with no diff, and `vp run agent-surface:context-budget-check` exited 0. `node scripts/goat-rename.ts --check`: 0 lines with T3 residue in 0 files.

NOT RUN: CI (it runs once on #3397); a real-client pass on web, desktop and mobile (captures are harness renders); a fresh review of this fix round; FcmDeliveries (no PostgreSQL on the gate host).

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-macbookpro2 (gate on pen-macbookair), coordinated by anthropic/claude-opus-5-5
