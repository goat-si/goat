# N16 Source control and git test speed (lane record)

Lane branch: `chase/t3-261114-n16-source-control`. Merged into the integration branch `chase/t3-261114-next` at `ffeb104573` (lane head `40dadeb1aa`, draft PR [#3519](https://github.com/goat-si/goat/pull/3519)); not in dev until #3519 merges. Follow-up head `db2b1a48034a0bc3a3dad1013d8c59d69b129792` (N16F, below). Follow-up db2b1a4803 merged into the integration branch at cb3d03bdce. Head `40dadeb1aabaa09b4f3393cb4a2151d23980355d` after the review fix round (based on dev `79a5cafe96`; the first READY was `8f7ba4655f6346746a21ab918fea93123998b8a4`, merged with dev `621e059da4`; the fix round merges dev `a11c5d644f` last). Host pen-macmini (juniui-Macmini.local, macOS 27.0, 10 cores, Node 26.12.1); the plan named pen-macbookair, the lane brief named this Mac. Rows from #3176: L51 (C5 A), L105 (C11 A), L118, and two `a3cde98425` remainders. Class: L105 and L118 are C4 in this cycle (coordinator, review round 1): GOAT's stored GitHub credential goes to a new endpoint and the server holds a long-lived stream per watched pull request for every github.com account, where upstream does so only for its opt-in app users. L51 and the test-speed rows are not C4.

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
- L105: gitHubPullRequestEvents.ts reads with `GitHubRest.credential(host)`. Left out: the app-credential gate (`rest.appCredential`, from skipped `0c80751701`) and the `personal` ending that retried with the user's token after the app token was refused; a 403/404 on the stream ends the feed ("stop"). Added because every github.com account now tries a subscription: the refusal pauses of the fix round below (N16-P2-1, P2-2, P3-3). User agent `goat`.
- L105 reactor: the sweep becomes `pass(changed)` under a one-permit semaphore. Change reads go through the same `readRetryAt` filter as the sweep, so an event read obeys the read backoff and its failures count toward `READ_FAILURE_LIMIT` through the existing `readGroup`. One feed per pull request in a FiberMap, at most 64 (N16-P2-3), settled 20 seconds (`Stream.debounce`, N16-P3-5) and then `Stream.buffer({ capacity: 1, strategy: "sliding" })`, so one queued read per PR. Change reads run inside `NodeSqliteClient.backgroundReads` like the sweep, and feeds start only after the automation hold releases. The new non-null assertion upstream adds (`group.targets[0]!`) is avoided.
- L105 test: upstream's runtimeLayer.test.ts case goes to a new PullRequestWatchHostEvents.test.ts with the shared testkit, following GOAT's split of watch tests (HiddenRemarks, Terminal, Wakes); runtimeLayer.test.ts has 82 lines left of its entry and the case is 121. Upstream's gitHubPullRequestEvents.test.ts carried with the app/personal case replaced by one host credential, the signed-out case by a rejected token, and one new case: a stream the token cannot read stops and deletes its subscription.
- docs/user/source-control.md says what reads besides the two-minute sweep (L105, L118).
- a3cde98425 GitManager: upstream's `GitFixtureTemplates` service and layer go to git/testkit/gitRepository.ts; `layerGitManagerTest` provides it; `createBareRemote` copies the bare template. Every `initRepo` caller runs under `layerGitManagerTest`.
- a3cde98425 gitFixture: upstream's lazy `repoTemplate` with `afterAll` cleanup. The template is built with GOAT's own steps (`driver.initRepo`, two configs, add, commit), and the branch is read from .git/HEAD. A copied repository skips `driver.initRepo`'s repository-path cache invalidation for cwd; all 34 callers pass.
- Not in this lane: the rest of `a3cde98425` (ci.yml concurrency, fast-import fixture, AcpAdapterV2 bundling) stays as #3176 rows 54 and 57 record.

## C4 (L105, L118)

- Credential: only GOAT's github.com host credential (`GitHubRest.credential(host)`). It goes to POST and DELETE `https://api.github.com/event-subscriptions[/<id>]` through GitHubRest, and to the stream request only when `events_url` has the origin `https://api.github.com`; any other answer is deleted by its id and pauses the credential (N16-P2-1, tested with another host, `api.github.com.evil.example`, `api.github.com@evil.example` and plain http). The token never reaches a URL, a log, a span or the wire.
- Hosts: github.com only. GitHub Enterprise and other hosts get no feed and no request.
- Limits (docs/internals/server-resilience.md): at most 64 feeds per server (`MAX_EVENT_FEEDS` in apps/server/src/orchestration-v2/goat/PullRequestEventFeeds.ts; only pull requests whose provider has an event feed take a slot (`PullRequestService.followsChanges`, N16F-P3-3), the first by pull request key, so the same ones keep their feed; the rest rely on the two-minute sweep). Subscribe calls run one at a time (a one-permit semaphore around the pause check and the POST, N16F-P3-1). SSE is parsed with `Sse.makeParser`, so one event is capped at 10 MiB and a `retry:` field is ignored (N16F-P3-2). Each feed holds one connection, one subscription, a 20-second settle and a sliding buffer of one. The pause map drops expired entries whenever it writes one. A DELETE waits at most 5 seconds; a stream request that gets no headers for 45 seconds reconnects; reconnects back off from 1 s to 60 s and end after six failures. Stale feeds are removed concurrently.
- Pauses, in memory per server, keyed by the credential fingerprint (`host:` plus SHA-256 of the token, never the token), so a replaced token or another account is asked again (N16-P3-3): 401, 403 and every other 4xx on subscribe pause the credential for an hour; 404 pauses that pull request for an hour; 422 pauses the credential for 10 minutes; 429 and secondary limits go through the host rate-limit pause the sweep shares; 5xx is asked again next sweep. A stream answering any 4xx except 429 stops, deletes its subscription and pauses that pull request for an hour (N16-P2-2, widened by N16F-P3-3); 429 and 5xx reconnect with backoff. An unusable 201 is deleted and pauses the credential (N16-P2-1).
- Live probe (once, 2026-11-16T08:26:13Z, pen-macmini, gh's own github.com credential, the body the code sends for goat-si/goat#3519 with `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`): `HTTP/2.0 403 Forbidden`, `Content-Type: application/json; charset=utf-8`, `X-Ratelimit-Resource: core`, `X-Ratelimit-Limit: 5000`, `X-Ratelimit-Remaining: 4757`, `X-Oauth-Scopes: gist, read:org, repo, workflow`, `X-Github-Request-Id: CC45:2C2026:5B86A0:998793:6AFABE25`; body `{"message":"Event subscriptions are not enabled for this account","documentation_url":"https://docs.github.com/integrations/how-tos/using-github-event-streams","status":"403"}`. No subscription was created, so no DELETE was sent, and no stream was opened. The code handles this as ruled: `isRateLimited` does not match (quota left, body names no limit), so it is a `GitHubApiResponseError` 403 and pauses that credential for an hour; such an account costs one POST per hour per server, covered by gitHubPullRequestEvents.test.ts ("leaves rejected tokens, other hosts, and refusals to polling").
- Wire and stored shapes: none change. `PullRequestProviderApi.changeRequestEvents` is optional and in-process; `PullRequestService.changes` is a server service method; no contract, RPC, event or projection changes. Older clients see only the existing pull request refresh notices, now also after a settled host event when the fingerprint moved; newer clients against an older server change nothing. Other providers have no feed and read by the sweep alone.
- GOAT difference to disclose (N16-P3-5, coordinator decision): a 20-second settle between a host event and its read. A wake costs the user a provider turn, so news that arrives in pieces (check suites, a review's comments) is read once and wakes at most once, close to what dev's sweep cost. Events closer than 20 seconds apart keep deferring the event read; the two-minute sweep still reads meanwhile.

## Fail-first

- L51 (`GitManagerForkPr.test.ts`, after the move-out, before the fix): 1 failed, 1 passed, `AssertionError: expected { number: 300, …(10) } to be null` at `expect(unpublished).toBeNull()` (the new thread's branch got the fork main's merged PR #300). After: 2 passed; GitManager.test.ts, GitManagerBasePr.test.ts and GitManagerForkPr.test.ts 130 passed.
- L105 (`PullRequestWatchHostEvents.test.ts` with the old reactor): 1 failed, `Error: Test timed out in 120000ms`: the old reactor never opens a host feed. After: 31 passed across the four watch test files; gitHubPullRequestEvents.test.ts 4 passed.
- L118: 1 failed, 3 passed, `AssertionError: expected { …(2) } to deeply equal { …(2) }`, the subscription lacks `com.github.pull_request.check_suite.status.changed.v1`. After: 4 passed.
- The two speed rows change no test file and no assertion (`git show --stat`: testkit files only); same test counts before and after.

## Review round 1 and fix round

Fresh review at `8f7ba4655f`: BLOCK, three P2 and six P3, all in L105's event feed (coordinator rulings and review, 2026-11-16). L51 and the test-speed commits passed and need no code change. One commit per ruling, failing test first:

| ruling | commit | fail-first on the code before it | after |
| ------ | ------ | -------------------------------- | ----- |
| N16-P2-1 | `e3895916189d43357a1f978541853bdaf7696424` | 5 failed: `the subscription GitHub made stays behind: expected [] to deeply equal [ 'event-subscriptions/1' ]` (four URL forms), `the host subscribes again at once: expected 2 to equal 1` (undecodable body) | 9 passed |
| N16-P2-2 | `c313d1ad1cc655bb2da9cccc2bcc9144db2d5360` | 6 failed: `a refused host is asked again at once: expected 2 to equal 1` (400, 410, 415), `the stream reconnected: expected 7 to equal 1` (stream 401), `the pull request subscribed again at once: expected 2 to equal 1` (stream 403, 404); the 422 and 502 cases pin existing paths and passed | 17 passed |
| N16-P2-3 | `1050e28a2b28323d7a6ccaec47bfce62200cfcb7` | 1 failed: `TypeError: feedsToFollow is not a function` (the cap is the selection the reactor's `follow` uses; a reactor test with 65 live watches cannot see when `follow` has finished without a sleep) | 2 passed |
| N16-P3-1 | `7c4cd50492abd2de8426e609c91c1a46aab173e0` | 1 failed: `the retry: line ended the connection: expected 4 to equal 1` | 18 passed |
| N16-P3-2 | `356dc87e21b03274bf98e9401d3e38915c8d8180` | 2 failed: `the feed still waits on GitHub's DELETE: expected undefined to not equal undefined`, `the stream request waited without a deadline: expected 1 to equal 2` | 20 passed |
| N16-P3-3 | `482fe4d48248c3495714fd832e952c2c97b93c8b` | 1 failed: `the host stays paused for the new credential: expected 1 to equal 2`. The credential is reached through `GitHubRest.credential(host)`, which already returns its fingerprint; no upstream interface widened | 21 passed |
| N16-P3-4 | `d57c0b8a3193ca160d177761dc39cf5c9579ff07` | against the reactor of `79a5cafe96`: `the reactor never opened a host feed: expected false to be true`. The case races the feed opening against the next sweep's read, so the fixed reactor never waits on the sweep timer; upstream's case is kept | 3 passed, three runs |
| N16-P3-5 | `498e62576ce529c658f72e40188a293ac5f711ee` | 1 failed: `a host event was read before it settled: expected 1 to equal +0` | 4 passed, three runs |
| N16-P3-6 | this record | Surfaces below | |

- N16-P3-5 also changes the upstream-ported case in PullRequestWatchHostEvents.test.ts (this lane's own new file, not a dev test): each event now waits for the feed to receive it and moves the clock 20 seconds before its read; its assertions are unchanged. The user guide sentence now says the check comes about 20 seconds after GitHub reports, so a burst is read once.
- N16-P3-2 also removes stale feeds with `concurrency: "unbounded"`; no separate test (the DELETE deadline is what bounded the wait).
- After the round: gitHubPullRequestEvents.test.ts 21 passed; PullRequestWatchHostEvents.test.ts 4 passed; PullRequestWatchWakes, Terminal and HiddenRemarks 30 passed; typecheck of source-control-github and server clean. No existing dev test expectation changed.

## Fix round verdict and follow-up

Fresh narrow review at `40dadeb1aa`: APPROVE WITH NITS, four P3; every round 0 fail-first rerun by the reviewer (report next-N16-fix-review-40dadeb1.md). Merged into `chase/t3-261114-next` at `ffeb104573`. Follow-up on the lane branch from `40dadeb1aa`, one commit per item, test first:

| item | commit | fail-first on the code before it | after |
| ---- | ------ | -------------------------------- | ----- |
| N16F-P3-4 | `affa937f0c` | none (verbatim move): `MAX_EVENT_FEEDS`, `EVENT_SETTLE` and `feedsToFollow` go from upstream's PullRequestWatchReactor.ts to apps/server/src/orchestration-v2/goat/PullRequestEventFeeds.ts behind one import; only `export` on `EVENT_SETTLE` changes (checked by a line diff). Fork-delta block `pr-event-feeds` on the records branch | 4 passed |
| N16F-P3-1 | `85437ccfca` | `each feed sent its own refused POST: expected 10 to equal 1` | 22 passed |
| N16F-P3-2 | `cc45cf04f1` | `Test timed out in 5000ms`: the 12 one-MiB chunks without a line end never ended the connection (the body is read through web streams outside the test clock, so the test waits for the body's cancel and cannot fail with a message on the old pipeline) | 23 passed |
| N16F-P3-3 | `fbebca905d` | `a host without an event feed took a feed slot: expected [ 'bitbucket.org' ] to deeply equal []` (65 github.com watches and one bitbucket.org watch, whose key sorts first) | 5 passed |
| N16F-P3-3 (stream 4xx) | `15b9170aed` | `the stream reconnected: expected 7 to equal 1` (400, 410, 422); 429 still reconnects (pinned) | 27 passed |

- N16F-P3-1: one permit for the module. Only github.com gets feeds, so it serializes every github.com credential's subscribe; ten feeds starting together on a refusing account send one POST.
- N16F-P3-3: `PullRequestService.followsChanges` is a new GOAT method beside upstream's `changes` (true where the project's provider has `changeRequestEvents`); the reactor filters candidates by it before the cap. GitHub Enterprise pull requests still count (the GitHub provider has the method; its feed is empty off github.com).
- Dev `c66dc0f1fd` merged last (`db2b1a4803`, clean).

## Test speed (same Mac, one run each, `/usr/bin/time -p vp test run …` in apps/server, nothing else heavy running)

| row | files | tests | before | after |
| --- | ----- | ----- | ------ | ----- |
| GitManager template repository and bare remote | 5 (GitManager.test.ts, .status-refresh, BasePr, DefaultBranchPush, ForkPr) | 136 passed both | 81.47 s (load 1.95) | 77.26 s (load 2.65) |
| shared initRepoWithCommit template | 34 (every test file importing initRepoWithCommit from vcs/testing/gitFixture.ts) | 328 passed both | 82.82 s (load 2.41) | 71.16 s (load 2.05) |

## Code budgets

| entry | before | after | real length |
| ----- | ------ | ----- | ----------- |
| `apps/server/src/git/GitManager.ts` lines | 3178 | 3124 | 3124 |

`PullRequestWatchReactor.ts` nonNull stays 3 (836 lines, no line entry). New files under the default, after the fix round: commitMessage.ts 72, gitHubPullRequestEvents.ts 323, gitHubPullRequestEvents.test.ts 444, PullRequestWatchHostEvents.test.ts 386. GitHubPullRequestApi.ts 2757 of 2759, PullRequestService.ts 3750 of 3916.

## Gate

- `db2b1a4803` (follow-up, dev `c66dc0f1fd` merged last; N5's focused run on pen-macmini had ended, no other check:changed or vitest run active): goat-rename --check 0 (also before the push); `vp run check:changed` with pipefail exit 0: goat-rename, format, lint, graphql (apps/server, packages/source-control-github), agent context budget, agent surface audit, typecheck (19 packages), knip 1/2 and 2/2, test (146 files, 2073 tests, 510 s). No known issue (goat#3238 and the rest) came up.
- `40dadeb1aa` (fix round, dev `a11c5d644f` merged last): goat-rename --check 0 (also before the push); `vp run check:changed` with pipefail exit 0: goat-rename, format, lint, graphql (apps/server, packages/source-control-github), agent context budget, agent surface audit, knip 1/2 and 2/2, typecheck (19 packages), test (146 files, 2066 tests, 505 s). Load 1.5 on 10 cores; no other heavy job on pen-macmini. No known issue (goat#3238 and the rest) came up.
- `8f7ba4655f` (dev `621e059da4` merged): goat-rename --check 0 (also before the push); `vp run check:changed` with pipefail exit 0: goat-rename, format, lint, graphql (apps/server, packages/source-control-github), agent context budget, agent surface audit, typecheck (19 packages), knip 1/2 and 2/2, test (146 files, 2046 tests, 555 s). No known issue (goat#3238 and the rest) came up.

## Surfaces

- L51 changes what a new branch in a fork checkout shows: no PR chip of the fork's main on web, desktop and mobile, and no such PR in the status agents read. It is a server-only logic fix in `branchPullRequest`, which every surface reads, proven by GitManagerForkPr.test.ts; no client code changes.
- Entry points: PR lookup for a branch (status, thread PR chips) goes through `branchPullRequest`; PR watches are started from the Linked pull requests panel, the thread details card and `pull_request.watch`, all ending in the same reactor. No client code changes.
- Clients and providers: server-only. Event feeds exist for github.com only.
- Settings and agent surface: none; agent-surface audit and context budget pass.
- Docs: docs/user/source-control.md updated.

## Known limits

- On an ordinary github.com account the feed never runs: GitHub refuses the subscription with 403 "Event subscriptions are not enabled for this account" (the live probe), so such an account gets only the two-minute sweep, plus one refused POST per hour per credential per server. Coordinator decision 2026-11-16: L105 and L118 stay in the lane; ruling C11 A stands.
- No live event stream has been seen. The stream handling (SSE frames, retry: lines, end frames, silence, reconnects, renewals) is proven only against a fake HTTP client in gitHubPullRequestEvents.test.ts.
- A subscription id of `.` or `..` from GitHub makes the DELETE path resolve to `/event-subscriptions/` or `/` on api.github.com (a no-op); an id holding a lone surrogate makes `encodeURIComponent` throw, ending that feed with a defect and no pause. Both need GitHub itself to send a malformed id.
- Two GOAT servers on one github.com account each hold their own feed and subscription; whether GitHub lets the second subscribe or ends the first is unknown (the probed account has no event streams).
- Users cannot turn the feed off; an account without event streams costs one refused POST per hour per server.
- Events closer than 20 seconds apart keep deferring the event read; the two-minute sweep still reads.
- Watches past 64 per server rely on the sweep.

NOT RUN: CI (ci:full); a live github.com event stream (the one probe was refused with 403; no account with event streams was available); two servers on one account; shutdown with GitHub unreachable (covered by the 5-second DELETE test); a real-client pass (no visible change); Windows and Linux hosts.
