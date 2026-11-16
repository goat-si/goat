# N16 Source control and git test speed (lane record)

Lane branch: `chase/t3-261114-n16-source-control`, head `8f7ba4655f6346746a21ab918fea93123998b8a4` (based on dev `79a5cafe96`, merged with dev `621e059da4`). Host pen-macmini (juniui-Macmini.local, macOS 27.0, 10 cores, Node 26.12.1); the plan named pen-macbookair, the lane brief named this Mac. Rows from #3176: L51 (C5 A), L105 (C11 A), L118, and two `a3cde98425` remainders. Class: not C4; L105 adds a host event read path and is reported C4-adjacent below.

## Rows and commits

| row  | upstream                          | GOAT commit                                | result |
| ---- | --------------------------------- | ------------------------------------------ | ------ |
| L51  | `eb8185560f` fork main's PR       | `25ba1990590801fe1a2014aae50227ba4811aae2` | ported; upstream's rule on GOAT's existing fork detection (`targetsRemote`), no new setting; the PR-branch test also accepts GOAT's flat `goat-pr-N-…` fallback name |
| L105 | `4e1be34436` host events          | `015dce97aab8f2b5f70799e4cf370c1a38d0a164` | ported with GOAT's host credential; `0c80751701` stays skipped |
| L118 | `e0d6aadb88` check suite events   | `2d4288ebb8b5e26b1de2ee30bc2dc16f70d16d12` | ported clean |
| a3cde98425 remainder | GitManager template repository and bare remote | `581bddeea964be4bb625a175621a8a1247fd6ecb` | ported into GOAT's shared testkit (`git/testkit/gitRepository.ts`, `GitManagerTestHarness.ts`) |
| a3cde98425 remainder | shared initRepoWithCommit template | `1c5a1fcab42ebd00fa4ca91d2ce33b01a612cf7a` | ported into `vcs/testing/gitFixture.ts` |

Lane commits that carry no upstream row:

- `9d3b9ee76ec80b9b51e0aed3bdbfb7e08969b317` refactor(server): move commit message helpers out of GitManager verbatim. GitManager.ts stood at its 3178-line entry; `sanitizeCommitMessage`, `sanitizeProgressText`, `CommitAndBranchSuggestion`, `isCommitAction`, `formatCommitMessage`, `parseCustomCommitMessage` and `MAX_PROGRESS_TEXT_LENGTH` move to apps/server/src/git/commitMessage.ts. Only `export` keywords and one import change (checked by a line diff of the removed and added text). GOAT-owned helpers in an upstream file; the next chase maps upstream hunks of these functions to commitMessage.ts.
- `8f7ba4655f6346746a21ab918fea93123998b8a4` merges dev `621e059da4` (mobile only), clean.

## Adaptations and left-out hunks

- L51: upstream's `isPullRequestWorktreeLocalBranchName` lives in apps/server/src/git/pullRequestBranchName.ts beside the name generator, and matches both `t3code/pr-N/…` and GOAT's flat `goat-pr-N-…` fallback. Upstream's test goes to GitManagerForkPr.test.ts (GOAT's fork PR test file; GitManager.test.ts is at its entry) with GOAT names, plus the flat-name branch.
- L105: gitHubPullRequestEvents.ts reads with `GitHubRest.credential(host)`. Left out: the app-credential gate (`rest.appCredential`, from skipped `0c80751701`) and the `personal` ending that retried with the user's token after the app token was refused; a 403/404 on the stream ends the feed ("stop"). Added because every github.com account now tries a subscription: a 401 on subscribe pauses the host for an hour, like upstream's 403. User agent `goat`.
- L105 reactor: the sweep becomes `pass(changed)` under a one-permit semaphore. Change reads go through the same `readRetryAt` filter as the sweep, so an event read obeys the read backoff and its failures count toward `READ_FAILURE_LIMIT` through the existing `readGroup`. One feed per pull request in a FiberMap, `Stream.buffer({ capacity: 1, strategy: "sliding" })`, so one queued read per PR. Change reads run inside `NodeSqliteClient.backgroundReads` like the sweep, and feeds start only after the automation hold releases. The new non-null assertion upstream adds (`group.targets[0]!`) is avoided.
- L105 test: upstream's runtimeLayer.test.ts case goes to a new PullRequestWatchHostEvents.test.ts with the shared testkit, following GOAT's split of watch tests (HiddenRemarks, Terminal, Wakes); runtimeLayer.test.ts has 82 lines left of its entry and the case is 121. Upstream's gitHubPullRequestEvents.test.ts carried with the app/personal case replaced by one host credential, the signed-out case by a rejected token, and one new case: a stream the token cannot read stops and deletes its subscription.
- docs/user/source-control.md says what reads besides the two-minute sweep (L105, L118).
- a3cde98425 GitManager: upstream's `GitFixtureTemplates` service and layer go to git/testkit/gitRepository.ts; `layerGitManagerTest` provides it; `createBareRemote` copies the bare template. Every `initRepo` caller runs under `layerGitManagerTest`.
- a3cde98425 gitFixture: upstream's lazy `repoTemplate` with `afterAll` cleanup. The template is built with GOAT's own steps (`driver.initRepo`, two configs, add, commit), and the branch is read from .git/HEAD. A copied repository skips `driver.initRepo`'s repository-path cache invalidation for cwd; all 34 callers pass.
- Not in this lane: the rest of `a3cde98425` (ci.yml concurrency, fast-import fixture, AcpAdapterV2 bundling) stays as #3176 rows 54 and 57 record.

## C4-adjacent (L105)

- Wire and stored shapes: none change. `PullRequestProviderApi.changeRequestEvents` is optional and in-process; `PullRequestService.changes` is a server service method; no contract, RPC, event or projection changes.
- Older client against this server: nothing new reaches it except the existing pull request invalidation notifications, now also sent after a host event when the fingerprint moved.
- This client against an older server: no client change.
- Other providers (GitLab, Azure DevOps, Bitbucket, GitCafe, …): no `changeRequestEvents`, `changes` is empty, the sweep alone reads.
- Negative cases: other hosts and GitHub Enterprise get no feed; a 403 on subscribe pauses the account for an hour, a 404 pauses that pull request, a 401 pauses the host; a stream answering 403 stops; a silent stream reconnects with backoff and ends after six failures, deleting its subscription (gitHubPullRequestEvents.test.ts).

## Fail-first

- L51 (`GitManagerForkPr.test.ts`, after the move-out, before the fix): 1 failed, 1 passed, `AssertionError: expected { number: 300, …(10) } to be null` at `expect(unpublished).toBeNull()` (the new thread's branch got the fork main's merged PR #300). After: 2 passed; GitManager.test.ts, GitManagerBasePr.test.ts and GitManagerForkPr.test.ts 130 passed.
- L105 (`PullRequestWatchHostEvents.test.ts` with the old reactor): 1 failed, `Error: Test timed out in 120000ms`: the old reactor never opens a host feed. After: 31 passed across the four watch test files; gitHubPullRequestEvents.test.ts 4 passed.
- L118: 1 failed, 3 passed, `AssertionError: expected { …(2) } to deeply equal { …(2) }`, the subscription lacks `com.github.pull_request.check_suite.status.changed.v1`. After: 4 passed.
- The two speed rows change no test file and no assertion (`git show --stat`: testkit files only); same test counts before and after.

## Test speed (same Mac, one run each, `/usr/bin/time -p vp test run …` in apps/server, nothing else heavy running)

| row | files | tests | before | after |
| --- | ----- | ----- | ------ | ----- |
| GitManager template repository and bare remote | 5 (GitManager.test.ts, .status-refresh, BasePr, DefaultBranchPush, ForkPr) | 136 passed both | 81.47 s (load 1.95) | 77.26 s (load 2.65) |
| shared initRepoWithCommit template | 34 (every test file importing initRepoWithCommit from vcs/testing/gitFixture.ts) | 328 passed both | 82.82 s (load 2.41) | 71.16 s (load 2.05) |

## Code budgets

| entry | before | after | real length |
| ----- | ------ | ----- | ----------- |
| `apps/server/src/git/GitManager.ts` lines | 3178 | 3124 | 3124 |

`PullRequestWatchReactor.ts` nonNull stays 3. New files under the default: commitMessage.ts 72, gitHubPullRequestEvents.ts 268, gitHubPullRequestEvents.test.ts 205, PullRequestWatchHostEvents.test.ts 213. GitHubPullRequestApi.ts 2757 of 2759, PullRequestService.ts 3750 of 3916.

## Gate

- `8f7ba4655f` (dev `621e059da4` merged): goat-rename --check 0 (also before the push); `vp run check:changed` with pipefail exit 0: goat-rename, format, lint, graphql (apps/server, packages/source-control-github), agent context budget, agent surface audit, typecheck (19 packages), knip 1/2 and 2/2, test (146 files, 2046 tests, 555 s). No known issue (goat#3238 and the rest) came up.

## Surfaces

- Entry points: PR lookup for a branch (status, thread PR chips) goes through `branchPullRequest`; PR watches are started from the Linked pull requests panel, the thread details card and `pull_request.watch`, all ending in the same reactor. No client code changes.
- Clients and providers: server-only. Event feeds exist for github.com only.
- Settings and agent surface: none; agent-surface audit and context budget pass.
- Docs: docs/user/source-control.md updated.

NOT RUN: CI (ci:full); a live github.com event subscription (needs an account with GitHub's event-stream preview; covered by the fake HTTP client tests); a real-client pass (no visible change); Windows and Linux hosts.
