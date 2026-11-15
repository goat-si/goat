# L06 retry: project and source control fixes (chase cycle 261114)

Lane branch `chase/t3-261114-scm-retry`, merged with `origin/chase/t3-261114-all` for hand-over. No pull request: the catch-up lands as #3397. This lane decides 22 upstream commits and ports 20 of them (19 adapt, 1 take); 2 are deferred. Each port's commit message names its upstream commit and decision. Lane review NOT RUN: Codex pool at its weekly limit.

## Decisions

Counts: 20 ported (adapt 19, take 1), 2 deferred (1 design question, 1 missing in-range predecessor). Deferrals are tracked in #3176.

| upstream | decision | GOAT commit | reason |
| --- | --- | --- | --- |
| `81c3da3856` removed thread worktrees keep their project's skills in the picker (#32471) | adapt | `497451ebff` | |
| `bbd51f74b4` import Codex chats moved into a project from the scratch folder (#32880) | adapt | `8c8dc5cc24` | |
| `c82e1ba515` GitLab review comments can cover a range of lines (#30535) | adapt | `3c36b316b9` | |
| `37452eeaa3` cloning into a stranded clone project's empty folder reuses that project (#33439) | adapt | `b54d958b41` | C4 contract, below |
| `362ef9a88a` GitLab: revert a merged merge request (#30556) | adapt | `5261d13fd3` | |
| `23132f8338` pull requests missing refs/pull/N/head no longer show as not found (#25947) | adapt | `db451b4dbc` | |
| `46002808e2` find pull requests for SSH aliases (#32932) | take | `5a941c6c7d` | |
| `10128e5925` repeated session imports reach transcripts behind the scan budget (#27215) | adapt | `fc5b8fe9d4` | |
| `c501ccad57` PR watch waits for queued GitHub workflow runs (#34624) | adapt | `9e6fa22993` | |
| `4ff329d108` fork PRs into gh's upstream base use an owner-qualified head (#35055) | adapt | `21432061ef` | |
| `41156481b1` a folder that only holds a repository's worktrees is refused as a project (#36366) | adapt | `88b6aa58f6` | |
| `d46b90c634` the Welcome page offers repositories you only worked on in worktrees (#33923) | adapt | `e39f72c7e9` | |
| `a1e0e507e1` status refresh on a fork's default branch is 2.5x faster (#33954) | adapt | `0260cd05db` | |
| `dbaef808d5` wake PR watches when the merge queue drops a pull request (#24141) | adapt | `c865238b1e` | C4 contract, below |
| `f59aa4eba0` reject PR watches when hosting dependencies are unavailable (#33389) | adapt | `a4b38b0204` | C4 permissions, below |
| `5e18314b88` Forgejo: fast-forward-only repositories can merge pull requests (#32738) | adapt | `7beb1754e1` | C4 contract, below |
| `2432ee10c6` blocked pointer-file scan test waits for the unblocked read (#36031) | adapt | `30f187f256` | test only |
| `9b6dde9a23` session import finds compressed Codex rollouts (#34947) | adapt | `d6b73cd03a` | |
| `2d5e0ae2bd` session import brings in the linked-worktree sessions the Welcome page counts (#36242) | adapt | `176ed9d206` | |
| `4596872940` linked-thread counts update when links change instead of polling every 10s (#35865) | adapt | `891349df0c` | C4 contract, below |
| `4e1be34436` watched GitHub pull requests react to host events, not only the 2-minute sweep (#33548) | deferred: design question | | Host event feeds must join GOAT's per-group watch read retry and backoff, which upstream does not have (apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:269, :555). |
| `e0d6aadb88` watched GitHub pull requests react when a check suite completes (#35709) | deferred: missing in-range predecessor | | Needs `4e1be34436`: its GitHub event module (gitHubPullRequestEvents.ts) is absent from packages/source-control-github/src/server/. |

Byte-identical moves came before ports whose files were near their code budgets, each in its own commit. The last move (`910a7a6b51`) came after the hand-over merge: merging put ProviderRegistry.ts at 1020 lines against its 1017 budget.

## C4 cases

- `37452eeaa3`: an older server always returns the requested project id, so newer web and mobile clients behave as before against it.
- `dbaef808d5`: a pull request and a saved watch from before the new field still decode, and an older peer drops the new keys. A blank removal id is rejected. A removal made by merging, or one older than the watch, does not wake it.
- `f59aa4eba0`: watching is refused when the host's CLI is missing, and unwatching still works. Watching a merged PR is refused. `watch_pull_request` returns the error and saves nothing. The command and stored data are unchanged, so older peers see no new shape.
- `5e18314b88`: an older server's merge options read as "no fast-forward", an older peer drops the new key, and an older server refuses a fast-forward merge request instead of merging another way.
- `4596872940`: an older server's capabilities read as not signalling linked-thread changes, and the client polls it without calling the new stream method. An older peer drops the new `linkedThreadRefreshes` key. A non-boolean value is rejected. `pullRequests.subscribeLinkedThreadRefreshes` refuses a session without orchestration read.

## Known limits

- `4596872940`: the change detector keeps side chats, because GOAT's linked-thread query lists them (upstream's excludes them).
- `2d5e0ae2bd`: GOAT's Codex history-thread imports take the worktree of their candidate's cwd, since a history thread has no transcript cwd. A GOAT test covers this.
- `dbaef808d5`: a merge queue removal follows the project's failed-check mode (react, keep as context, or ignore). Upstream has no such setting.

## Surfaces

- Server: every row.
- Web and mobile: `37452eeaa3` (follow the returned clone id). Linked-thread refreshes (`4596872940`) reach web and mobile through the shared client runtime.
- Desktop: no change beyond web.
- Agents and MCP: `f59aa4eba0` (`watch_pull_request` refuses when the hosting tool is missing). The agent surface audit counts the new error tag.
- Providers: GitHub, GitLab, and Forgejo rows as named. No agent provider adapters change.

## Captures

None. These rows change server behaviour, imports, and refresh timing, with no visible UI layout change.

## Hand-over merges

- `a49d76548f` merges `origin/chase/t3-261114-all` at `56421003ff`. Conflicts: ProviderRegistry.ts keeps the integration branch's scan-base snapshot and this lane's `scanCwd`; environment.test.ts keeps both sides' capability tests.

## Tests

The fail-first runs below were done on run 4 (this round), and on run 3 for its five rows. Evidence for runs 1 and 2 is in their run reports and was not repeated here.

- `9b6dde9a23`: 2 failed before (`expected []`), then 100 passed across the scanner and importer files.
- `2d5e0ae2bd`: 3 failed, 14 passed with the source change stashed, then 102 passed.
- `4596872940`: 7 failed, 91 passed before (the service test timed out because no refresh was signalled), then 195 passed across 11 files. The full runtimeLayer.test.ts passed 171 of 171.
- Run 3: `a1e0e507e1` 2 failed, then 165 passed. `dbaef808d5` 11 failed, then 423 passed. `f59aa4eba0` 4 failed, then 209 passed. `5e18314b88` 4 failed, then 37 passed. `2432ee10c6` 66 passed (test only).

Gate on the pushed head `9dfe33f115` (`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 VITEST_MAX_WORKERS=4 vp run check:changed` with pipefail, exit 1):

```
check:changed summary
  pass  unused patches  0.7s
  pass  format  0.3s
  pass  lint  3.8s
  pass  knip 1/2  10.8s
  pass  knip 2/2  17.0s
  pass  graphql (apps/server)  1.1s
  pass  graphql (packages/source-control-github)  1.3s
  pass  agent surface audit  6.7s
  pass  agent context budget  6.3s
  pass  typecheck (42 packages)  18.5s
  FAIL  test (1587 files)  1488.6s
 Test Files  1 failed | 1578 passed | 8 skipped (1587)
      Tests  1 failed | 24346 passed | 24 skipped (24371)
```

The one failure, packages/ssh/src/runtimeFactsScripts.test.ts ("reads a built runner in one call..."), comes from `chase/t3-261114-all`, not this lane: packages/ssh is byte-identical to `56421003ff`. It also fails when run alone. It counts bash xtrace lines, and this Mac's /bin/bash is 3.2.57, whose trace format it does not match.

Commits after the hand-over merge: `910a7a6b51` moves the saved Antigravity account carry-over out of ProviderRegistry.ts. `b2121112b6` lowers 13 budget entries, only for files this lane's own commits shrank (read with update-code-budgets.ts; entries other lanes changed are left alone). `bb931b8907` drops exports that knip found unused and refreshes docs/internals/agent-surface-audit.md (the pull request toolkit has 22 error tags). `9dfe33f115` classifies PullRequestUnavailableError's reasons in FAILURE_CLASSES: the `f59aa4eba0` watch refusal adds that error to the pull request tools, and agentSurface.failureClasses.test.ts failed without the classes.

`node scripts/goat-rename.ts --check`: 0 lines with T3 residue in 0 files.

NOT RUN: lane review (Codex pool at its weekly limit); CI (it runs once on #3397); the fail-first runs for runs 1 and 2 were not repeated this round.

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-macbookpro2, coordinated by anthropic/claude-opus-5-5
