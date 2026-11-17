# next3 K1: pull request watch chain (plan)

Lane K1 of next3 ([card 10.028](../10.028_t3_chase_cycle_261114_next3.md), [plan and ruling](./next3-plan.md)). Host pen-lidge (hostname lidge-AI-AI), server only. Branch chase/t3-261114-next3-k1-pr-watch, HEAD a608046c519b9377be3f03a5cdd6b376dd1b5c3f (= origin/chase/t3-261114-next3, checked). Upstream fetched: upstream/main 51eb2d5437. Status: PLAN, no code commit, waiting on the coordinator's ruling.

Rows in order: 0af2d21647, 1de3c3c68c, 072254ddd3, 36254ab82e, 1df9c91230, eb7e63a822. Class: C4 for the lane (wire fields, stored watch state, a public MCP tool schema).

## 1. Ancestry check (#3519 = 3ecea04f19, #3660 = 42bf8633ce)

No row is carried by #3519 or #3660. Evidence, all on a608046c51:

- git log --grep=<sha> over dev history finds none of the six short SHAs (bodies of #3519 and #3660 included).
- rg over packages/ and apps/server/src finds none of the identifiers the rows add: watchStartedAt, otherPullRequests, includesRemarks, PullRequestWakeSection, awaitingBaseline, checksPending, checks-reopen, isPullRequestWatchTask, pullRequestCount, openPullRequestCount. No hits.
- git merge-tree --write-tree --merge-base=<sha>^ HEAD <sha> conflicts for every row: 0af2 in 4 files, 1de3 in 5, 0722 in 6, 3625 in 8, 1df9 in 2, eb7e in 6 (two modify/delete: apps/server/src/provider/agentContextBudget.json and evals/mcp-tool-use/run.ts do not exist in GOAT).

One row is mostly covered by GOAT's OWN earlier design (not by #3519/#3660), see 0af2d21647 below: that goes to the coordinator as decision D1; I do not tick it myself.

## 2. The C4 question first: every wire field, each way

Facts this rests on:

- GOAT decodes these structs with Effect Schema's default, which ignores unknown keys. onExcessProperty: "error" appears only in memory, screen code, opencodex and text generation decoders (rg onExcessProperty), none of the schemas below.
- Command receipts store command_id, thread_id, command_type, status and error only (apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:42). Internal command payloads (OrchestrationV2InternalCommand, packages/contracts/src/orchestrationV2.ts:3494) are never stored and never reach a client.
- The watch (ThreadPullRequestWatch, packages/contracts/src/threadPullRequest.ts:84) IS stored (thread.pull-request-link-updated and thread.pull-request-synced event payloads, the thread projection) and IS sent to clients inside the thread shell's pullRequests.
- Clients derive held background work themselves with the shared derivePendingBackgroundWork: packages/client-runtime/src/state/threadExecution.ts:405, packages/client-runtime/src/operations/commands.ts:885, apps/web/src/components/chat/threadPendingBackgroundTasks.ts:35, besides the server's apps/server/src/orchestration-v2/threadShellProjection.ts:39.
- MCP thread read and list results are decoded with the strict schema by the CLI (apps/server/src/cli/thread.ts:353-619 thread read, :733 thread list) and by fleet health, which reads threads on OTHER hosts (apps/server/src/fleet/health/Health.ts:31-45 via callHostTool). A required field added to OrchestratorMcpThreadPullRequest therefore breaks a newer reader against an older server.
- pull_request.list is hostRoutable: false (packages/contracts/src/agentSurface/entries/pull_request.ts:116); ListThreadPullRequestsResult is used only by its tool and handler (apps/server/src/mcp/toolkits/pullRequests/tools.ts:287, handlers.ts:39). Its only reader is an agent.

| Row | Field | Where | Older client or reader vs newer server | Newer client or reader vs older server | Stored |
| --- | --- | --- | --- | --- | --- |
| 0af2 upstream | notification.source monitor .pullRequest stamp | stored message, client wire | ignored | absent, no stamp | yes, in messages |
| 0af2 GOAT plan | none: GOAT keeps its message-id encoding (apps/server/src/orchestration-v2/goat/PullRequestWatchWakes.ts:22-49) | - | unchanged | unchanged | no |
| 1de3 upstream | source .otherPullRequests[], stamp .section; internal sync .others[], wake .sections[] | stored message and internal | ignored | absent | yes |
| 1de3 GOAT plan | internal thread.pull-request-watch.sync gains optional others[] (key fields, startedAt, watch, endedWatch). The one wake is a digest of per-PR notices in GOAT's existing format (TurnDigest renderDigest), so no new client field | internal only | a digest message, which every client already renders | n/a (server-internal) | no |
| 0722 | watch.awaitingBaseline?: "all" or "checks" | stored watch, client wire | ignored, nothing shown | absent = not awaiting, today's behavior | yes, optional key, no migration |
| 3625 | watch.checksPending?: boolean | stored watch, client wire, client-side derivation | the older client derives "held" as today, so it keeps the thread in Working after checks finish while the server shell and newer clients show it in the inbox; ends at upgrade, nothing lost | absent: checksPending === false is false, so the watch holds as today | yes, optional key; a watch saved before it gets one extra host read (planRead treats undefined as due), bounded by the watch count |
| 3625 | internal thread.pull-request-watch.checks-reopen; sync .checksPendingBefore? | internal only | n/a | n/a | the receipt stores the type string only |
| 1df9 upstream | OrchestratorMcpThreadPullRequest.watching (REQUIRED), .watchStartedAt (REQUIRED NullOr); list and detail .pullRequestCount? | MCP results | agent: extra keys; CLI and fleet: ignored | CLI and fleet decoding an older server's read with pullRequests FAIL the whole read | no |
| 1df9 GOAT plan | same fields, watching and watchStartedAt OPTIONAL (decision D3) | MCP | ignored | absent, decodes | no |
| eb7e | list and detail .openPullRequestCount?; pull_request.list input .states?[], .cursor?; result .nextCursor (NullOr, required as upstream) | MCP | an agent passing no cursor gets the first 50 and a nextCursor | an agent passing cursor or states to an older server: the extra keys are ignored by the default decode (proved by a test against the tool's parameter schema), so it gets the whole unpaged list | no |

Negative cases settled here, each a test in the row below: a watch that ended or moved during a batched read; a baseline read with no head SHA or a failed approval lookup; a push while a read is in flight; a reopen with nothing to clear; an older server's thread read without the new fields, decoded by the newer reader; paging while PRs are unlinked between pages; an older-server tool call with unknown params.

## 3. Rows

### 0af2d21647 drop stale queued pull-request watch wakes (#21239)

Upstream stamps each wake's notification with the watch's startedAt, head and watchEnded, and re-validates a queued wake when it is about to start (Orchestrator isStalePullRequestWatchWake), plus an idle-dispatch check.

GOAT already does this at the moment of change instead of at dequeue, with no wire field (#926, #1056): the wake's message id names the PR and, for check-only wakes, the head (goat/PullRequestWatchWakes.ts:1-49); unwatch, unlink and a recorded merge drop queued wakes (Orchestrator.ts:12373, PullRequestWatchWakes.ts:73-91); a closed or merged sync drops them (dropQueuedWakes, Orchestrator.ts:2632); a push drops other heads' check results (Orchestrator.ts:2633-2634, goat/PullRequestDigest.ts:120-185); a settled, archived or merged thread mutes the idle dispatch (pullRequestWakeMuted, PullRequestWatchWakes.ts:58-70). Mapped tests in apps/server/src/orchestration-v2/PullRequestWatchWakes.test.ts: :302 (merged never starts a turn), :321 (merge recorded before the sweep), :344 (closed), :375 (unwatch, unlink), :415 (push, #1056), :838 (merged leaves a shared digest).

Gap found from upstream's "reopened" and "closed notice" cases: GOAT's watch command (thread.pull-request.watch, watching: true) drops nothing, so an ending notice ("closed, stopped watching" or the comment-limit notice) still queued behind a busy turn reaches the agent AFTER a new watch started on the same PR and tells it the watch stopped. Plan: a failing-first test in a new apps/server/src/orchestration-v2/PullRequestWatchRestart.test.ts (PullRequestWatchWakes.test.ts is at 934 lines), then the fix in goat/PullRequestWatchWakes.ts and the watch case at Orchestrator.ts:12371-12373: starting a watch drops that PR's queued ending wakes of the previous watch. An ending wake can carry news it read (endingWakeText, goat/PullRequestDigest.ts:233-246); upstream drops it too. Decision D1. If the test passes on dev, the row is ticked with this mapping and no code.

Class C4 (queued run cancellation), size S. Budget: Orchestrator.ts is AT its entry (13528); the fix goes into goat/; if a line must be added there, a verbatim move-out commit comes first (section 5).

### 1de3c3c68c a pass that changes several watched PRs wakes their thread once (#35109)

GOAT gap, to be shown by the failing test: on an idle thread, one sweep that finds news on PR A and PR B dispatches two sync commands; A starts a turn at once and B queues, so the thread runs twice. Digest folding (TurnDigest) merges only notices that queue behind a turn.

Plan, GOAT-native: the reactor holds the pass's wakes per thread (upstream's hold, sendHeld, sendTogether) in a new goat/PullRequestWatchBatch.ts (PullRequestWatchReactor.ts is 826 lines and must stay under 1000). One sync command carries the others in an optional internal others[]; dispatchPullRequestWatchSync checks every entry's startedAt and mute state and refuses the whole command if any ended or was muted during the read, and the reactor then sends each alone (upstream's fallback). The message is one digest of per-PR notices with GOAT's existing notice ids, so dropQueuedPullRequestWakes keeps dropping one PR's part and leaving the rest (proved at PullRequestWatchWakes.test.ts:838). No notification source stamps.

Tests in a new apps/server/src/orchestration-v2/PullRequestWatchBatch.test.ts: (fails first) an idle thread with two PRs changed in one pass starts one turn naming both; (negative) a watch that ended during the read sends the other PR's wake alone; a merged PR leaves a reactor-built batched digest and the other notice stays, only if :838 does not already cover it.

Class C4, size M. Budget: orchestrationV2.ts AT entry (4438) gets others[] (about 10 lines) and Orchestrator.ts AT entry gets the multi-entry check: move-out commits first (section 5).

### 072254ddd3 baseline existing PR checks when watching (#23522)

GOAT today reports, on a new watch's first read, failures and conflicts that were already there (newPullRequestWatch starts from empty state, apps/server/src/orchestration-v2/goat/PullRequestAutoWatch.ts:20-51). Port: awaitingBaseline on the watch, set to "all" by newPullRequestWatch when there is no ended watch to resume; evaluatePullRequestWatch (pullRequestWatch.ts) records instead of reporting while it is set; watchesEqual in PullRequestWatchReactor compares it; headMoved needs a known previous head.

Tests: upstream's eight evaluate cases in a new apps/server/src/orchestration-v2/pullRequestWatch.baseline.test.ts (pullRequestWatch.test.ts is 930 lines), failing first on dev: existing failures and conflicts baselined, then new ones reported; approval-awaiting checks baselined; remarks still reported during the baseline; a failure reported once the head SHA appears after a baseline without one; a baseline taken without a head kept; a failed approval lookup keeps the baseline; advisory checks finishing after a required-check baseline; the no-checks clock starting during the baseline. Plus the runtime case "baselines a new watch across restarts and reports later changes" in PullRequestWatchRestart.test.ts.

Expected rule 3 asks: upstream rewrote its own "an hour later" no-checks case and its "wakes once ... across a restart and a new watch" runtime case, because headMoved changed for a null head. GOAT's counterparts (pullRequestWatch.test.ts, PullRequestWatchTerminal.test.ts, PullRequestWatchHostEvents.test.ts, runtimeLayer.test.ts) are found by running them after the port; each failing expectation goes to you through needs_input with its exact before and after, and none changes before your word.

Decision D5: the baseline also applies to automatic watches.

Class C4 (stored watch field), size M. Budget: pullRequestWatch.ts unlisted (636), PullRequestAutoWatch.ts 141, threadPullRequest.ts 141: no move-out; Orchestrator.ts untouched (GOAT's seam is PullRequestAutoWatch.ts).

### 36254ab82e a watched PR stops holding its thread once its checks finish (#33214)

Port: checksPending on the watch (evaluatePullRequestWatch); derivePendingBackgroundWork marks a watch awaited only while checksPending is not false, and monitorHoldsWakeCompletion ignores PR watch tasks (packages/shared/src/orchestrationV2PendingBackgroundWork.ts:116, :309-330); PullRequestSyncReactor detects a push command and dispatches the internal thread.pull-request-watch.checks-reopen (also added to commandThreadId.ts:33); the sync carries checksPendingBefore so a read in flight across a push does not restore the old head's answer; auto-settle refuses a thread with a PR watch task (ThreadSettlementService isAutoSettlementCandidate, :158). GOAT's watch task list already excludes automatic watches (orchestrationV2PendingBackgroundWork.ts:314-317), so the guard covers explicit watches only, and threads with automatic watches keep auto-settling as today. Docs rewritten in place: docs/user/source-control.md:395-398 and docs/user/thread-sidebar.md (Working section).

This changes GOAT's stated rule that an explicit watch keeps the thread working between wakes (docs/user/source-control.md:370-371): decision D2.

Tests, failing first: the shared case "stops a watch whose checks all finished from holding the thread, while still listing it" (orchestrationV2PendingBackgroundWork.test.ts, 536 lines); the evaluate cases "counts checks as pending until every one has finished" and "waits a while for a new head's checks on every host" (pullRequestWatch.baseline.test.ts or a sibling); "reopens a watch's checks when its thread's agent pushes" in PullRequestSyncReactor.batching.test.ts (166 lines; PullRequestSyncReactor.test.ts is AT its entry 1741); negative: a push during an in-flight read keeps the cleared answer; a reopen with nothing answered is accepted as a no-op; the auto-settle guard in a new ThreadSettlementService.watch.test.ts (ThreadSettlementService.test.ts is AT its entry 1599; a new file needs no TEST_TITLES change).

Client half: no client code (the shared function is the clients' too), but the Working section changes on web, desktop and mobile: a P1 row (capture: a thread whose watched PR's checks all finished leaves Working). No capture here.

Class C4, size M. Budget: Orchestrator.ts and orchestrationV2.ts AT entry (checks-reopen case, syncedPullRequestWatch, the command schema): move-outs first; PullRequestSyncReactor.ts (834) and PullRequestWatchReactor.ts stay under 1000.

### 1df9c91230 thread reads list only open linked PRs and show their watch state (#34895)

Port into GOAT's projection, apps/server/src/mcp/threadListView.ts:185-198 (threadPullRequests), :237 and :276: only PRs not merged or closed, each with watching and watchStartedAt; pullRequestCount on list items and on the detail; the detail's PR list only on the first page (the call site in OrchestratorMcpService passes afterPosition and itemId both undefined). Behavior change for agents: merged and closed PRs leave thread list and read, and stay in pull_request.list.

Decision D3: watching and watchStartedAt OPTIONAL in GOAT (upstream: required), because the CLI and fleet health decode thread reads from servers that may be older (section 2).

Tests in apps/server/src/mcp/OrchestratorMcpService.activity.test.ts (806 lines), failing first: a list and a read show only open PRs with watch state and the total count; a later page carries the count without the list. Contract negative: OrchestratorMcpThreadReadResult decodes an older server's payload whose pullRequests lack watching and watchStartedAt (a test beside packages/contracts/src/orchestratorMcp.ts).

Class C4 (public MCP result), size S. Budget: orchestratorMcp.ts AT entry (1083): +4 lines need a move-out first; OrchestratorMcpService.ts AT entry (3871): zero net lines at the one call site, else a move-out.

### eb7e63a822 thread reads preview linked PRs and list_thread_pull_requests pages (#35858)

Port: thread list and read preview at most 5 open PRs, watched first then newest (threadPullRequestUpdatedAtMs exported from packages/shared/src/threadPullRequests.ts), plus openPullRequestCount; pull_request.list gains states and cursor, pages of 50 ordered by (linkedAt, host, repository, number) with the page's stacks whole, and nextCursor. Agent surface: the pull_request.list entry's guide (packages/contracts/src/agentSurface/entries/pull_request.ts:104-120) and its signature line "(pull_request.list :threadId?)" (packages/contracts/src/agentSurface/surfaceEntries.ts:43) name the new inputs. Not ported: agentContextBudget.json and evals/mcp-tool-use/run.ts (absent in GOAT), and upstream's rewording of the link_many and unlink_many descriptions (GOAT's text lives in its registry and is not part of the fix).

Tests, failing first: "pages a large list once through, with each page's stacks whole" and "filters by state before paging, counting a PR with no known state as open" in apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts (753 lines); the preview case in OrchestratorMcpService.activity.test.ts; negative: unlinking a returned page does not skip later PRs (inside the paging case), and a call with cursor and states decodes against a parameter schema without them (older server).

Rule 3, certain: handlers.test.ts:447 expects list order [3, 1, 2, 10] and :448 checks entry [0]; with the new total order they become [1, 2, 3, 10] and entry [2], the same PR (upstream made the same change to its own test). handlers.test.ts:496-499 ([2, 1] for two native stack layers with one linkedAt) may change too. Decision D4.

Class C4 (MCP tool schema), size M. Budget: orchestratorMcp.ts AT entry: +2 lines, in the same move-out as 1df9.

## 4. Order and size

One commit per row in the brief's order, each move-out commit right before the first row that needs it: (m1) Orchestrator.ts move-out, (m2) orchestrationV2.ts move-out, 0af2 (S, or a tick), 1de3 (M), 0722 (M), 3625 (M), (m3) orchestratorMcp.ts move-out, 1df9 (S), eb7e (M). Lane total M-L, about 1.3k added lines, most of them tests. Then one merge of the integration head, check:changed against origin/chase/t3-261114-next3 plus the focused files, this record, READY.

## 5. Budgets (oxlint-plugin-goat/code-budgets.json; countLines equals wc -l, every file newline-terminated)

| File | Lines | Entry | Rows | Move-out |
| --- | --- | --- | --- | --- |
| apps/server/src/orchestration-v2/Orchestrator.ts | 13528 | 13528 | 0af2 (maybe), 1de3, 3625 | yes: dispatchPullRequestWatchSync (Orchestrator.ts:2598-2670) moves verbatim into a goat/PullRequestWatchSync.ts factory, as makePullRequestWakeDrops already is; every removed line not re-added explained one by one here |
| packages/contracts/src/orchestrationV2.ts | 4438 | 4438 | 1de3, 3625 | yes: the thread.pull-request-watch.sync struct (about :3577-3600) moves verbatim to a contracts module and is referenced from the union |
| packages/contracts/src/orchestratorMcp.ts | 1083 | 1083 | 1df9, eb7e | yes: OrchestratorMcpThreadPullRequest and its type move verbatim to a sibling module |
| apps/server/src/mcp/OrchestratorMcpService.ts | 3871 | 3871 | 1df9 | only if the call site cannot stay at zero net lines |
| runtimeLayer.test.ts 9983, PullRequestSyncReactor.test.ts 1741, ThreadSettlementService.test.ts 1599 | at entry | at entry | - | untouched: new tests go to new or unlisted files |
| PullRequestWatchReactor.ts 826, pullRequestWatch.ts 636, PullRequestSyncReactor.ts 834, handlers.ts 795 (nonNull entries only) | unlisted lines | - | - | stay under 1000; no new non-null assertions (upstream's first! and stamps[0]! are rewritten without them) |

## 6. Decisions for the coordinator, one paragraph each

D1 (0af2d21647). GOAT already drops stale queued watch wakes at the moment of change through message-id encoding (#926, #1056), so I propose NOT porting upstream's notification stamps (a stored, client-visible field) and ticking the row against the mapping in section 3, except one gap: a new watch on a PR does not drop the previous watch's queued ending notice. I propose the failing-first test and a fix that drops it, as upstream does, accepting that held context that notice carried is dropped with it (the new watch resumes from the ended watch's state, so checks and conflicts it told are not repeated). Alternative: keep the notice and rewrite its closing line. Recommended: drop, as upstream.

D2 (36254ab82e). In GOAT an explicit watch keeps the thread in Working between wakes and an automatic watch never does (docs/user/source-control.md:368-371). Upstream's change makes a watch hold only while checks run, then returns the thread to the inbox with the watch still on and auto-settle blocked. Options: A port it for explicit watches (docs rewritten; older clients show Working longer until they upgrade); B skip, GOAT's automatic/explicit split being its own answer to the same problem; C port only the push reopen and the in-flight guard without changing what holds. Recommended: A.

D3 (1df9c91230). Upstream adds watching and watchStartedAt as REQUIRED fields of the MCP thread PR entry. GOAT's CLI (cli/thread.ts:353, :733) and fleet health (fleet/health/Health.ts:45, reading other hosts) decode these results with the strict schema, so a required field makes a newer reader fail on an older server's thread read. I propose both optional in GOAT, a disclosed departure, with a contract test that an older payload decodes.

D4 (eb7e63a822, rule 3). The paging cursor needs a total order that survives unlinking, so pull_request.list returns PRs by (linkedAt, host, repository, number) instead of stored order. That changes existing expectations at apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts:447 (before [3, 1, 2, 10], after [1, 2, 3, 10]) and :448 (before result.pullRequests[0], after result.pullRequests[2], the same PR #1 object), and possibly :496-499. I ask your word on those lines now; any further line found when the tests run comes to you with its exact before and after first.

D5 (072254ddd3). The baseline applies to every new watch without an ended one, automatic watches included, so a thread that links an already failing PR is no longer woken for the failures already there. Recommended: as upstream, for both kinds.

## 7. Risks

- Two at-entry budget files on the main path (Orchestrator.ts, orchestrationV2.ts): the move-outs must be verbatim and each removed line explained; if a verbatim move is impossible without behavior edits, I stop and report.
- 072254ddd3 and 36254ab82e change first-read and hold semantics several GOAT watch tests assume; the rule 3 list is known only after the port runs, and each item waits for your word.
- Batching against GOAT's kept context (#1055): a batched digest must still carry kept context once; covered by running PullRequestWatchWakes.test.ts unchanged.
- One heavy job at a time on pen-lidge; K6 follows here.

## 8. NOT RUN expected at READY

- NOT RUN: web, desktop and mobile capture of the Working section after checks finish (36254ab82e): pen-lidge is server-only; a P1 row.
- NOT RUN: a real GitHub or GitLab host read: tests use the fake host, as upstream's do.
- NOT RUN: an actual older client or older server process: covered by schema decode tests both ways, not by running two builds.
- NOT RUN: goat-ci: the coordinator dispatches lane=quick on the READY head.
- NOT RUN: the agentContextBudget and evals hunks of eb7e63a822: those files do not exist in GOAT.
