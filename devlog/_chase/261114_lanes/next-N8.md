# N8 Remote tasks and CLI wait (lane record)

Lane branch: `chase/t3-261114-n8-remote-tasks`, accepted at `fa4899666f8e1c4c1b407ebbc9fa12d3cc05c299`, follow-up round head `0ff08e8a041e45679a2afe074c7b4d34b198d234` (based on dev `26847e90dc`, merged with the integration branch at `44d7d60d20`; dev has nothing newer). Host pen-macmini (juniui-Macmini.local, macOS 27.0, 10 cores, Node 26.12.1). Rows from #3176: L132 (O9 A), L135 (O11 C), L215 (C18 A). C4: O9 (new stored dispatch records) and C18 (contract field).

## Rows and commits

| row        | upstream                           | GOAT commit                                | result                                     |
| ---------- | ---------------------------------- | ------------------------------------------ | ------------------------------------------ |
| L132 (O9)  | `ed57b9b5ec` remote follow-up task | `30c6311eefa4be67544278c8df5258498e2e1ff8` | adapted onto RemoteDispatchCoordinator     |
| L135 (O11) | `571b319643` follower defect       | `c5d069e2f4187b0f09e7de18435336a2304c393c` | adapted onto LaunchWatchService (option C) |
| L215 (C18) | `671f85417c` thread --wait         | `7ff13b9ef33e20126c2c7bcd490628db3cf7eaaa` | ported; server field added (option A)      |

Lane commits that carry no upstream row:

- `ad97d2be6a` move-out: the launch watch StepResult type to launchWatchFollower.ts, unchanged (LaunchWatchService.ts had 1 line left).
- `1804459cda` move-out: mergeHostThreadLists and newestFirst to hostThreadLists.ts, unchanged; HostThreadsMcpService re-exports it (the file was at 999 of the 1000 default).
- `2b05bf46a6` move-out: the capability schemas to packages/contracts/src/orchestratorMcpCapabilities.ts, unchanged; orchestratorMcp.ts re-exports them (1160 of 1161).
- `15dd516bbb` merge of origin/chase/t3-261114-next `44d7d60d20`, clean.
- `60984f12e0` moves this lane's own registration test to DelegatedCompletionDelivery.remoteFollowUp.test.ts, unchanged: the integration branch grew DelegatedCompletionDelivery.test.ts to 2267 of 2332.
- `04acada133` move-out: the scheduled task webhook URL text to scheduledTaskWebhookUrl.ts, unchanged: the C18 lines put OrchestratorMcpService.ts 7 over its integration entry (3957).
- `27ef9097b3` test helper uses Schema.is (effect diagnostic).
- `fa4899666f` regenerated docs/internals/agent-surface-audit.md after the merge (the integration branch and this lane each added a described parameter).

No goat-rename rule or TEST_TITLES entry names DelegatedCompletionDelivery.test.ts or the moved title; goat-rename --check 0.

## Decisions (verbatim)

- O9: "A: a follow-up send to a finished remote task creates a new dispatch record bound to the parent's latest run and wakes the parent, built on RemoteDispatchCoordinator."
- O11: "C: restart the follower with bounded backoff, then \"lost track; the remote run may still be running\" with the task left non-terminal and visible; never report a false failure."
- C18: "A: optional untilDelegatedWorkSettled-style input field plus a result field saying the server honoured it; the CLI falls back on older servers; the agent's thread.wait gets the same field within the description budget."

## What each row does here

- O9: after a goat_thread_send through a host that starts or queues a run on the thread of one of the caller's remote tasks that has its result, remoteTaskFollowUp.ts writes a new remote_dispatches row (kind task, reports_supported 0, launched_run_id = the follow-up's run) and dispatches delegated_task.remote.register bound to the parent's latest run (followUpOwnerRun: latest active run, else the last that ran), completionWake "always"; the coordinator drain follows that run with goat_thread_wait and records its result, which wakes the parent. The send result carries taskId. Steers, relayed sends and sends to a thread with no finished task of the caller record nothing; a retried send (same message id there) records one task; a refused registration removes the row and the send says "The message was sent, but its task was not recorded". RemoteDelegatedTasks accepts an ended parent run only for such a follow-up. A goat_thread_wait answer's structured result summary now becomes the task's result when present.
- O11: a launch watch follower that dies on a defect restarts after 5s, 10s, 20s (TestClock); one that ran 10 minutes before its defect starts over. After the fourth defect in a row the launcher gets one wake ("GOAT lost track of …; the remote run may still be running"), the watch stays listed with its pending run, and the next goat_thread_send or a restart follows it again. Why these numbers: upstream fails after 3 defects; 5s matches the coordinator drain's first backoff, doubling keeps the whole budget at 35s so a real bug is reported within a minute, and 10 minutes of healthy running separates a new defect from the same one. RemoteDispatchCoordinator drains are unchanged: they already retry every non-interrupt cause with bounded backoff (5s to 300s) and leave the task non-terminal.
- C18: goat_thread_wait takes untilDelegatedWorkSettled; with it ThreadManagementService waits until delegatedTaskProgress says result_available and no result is pending, and the result carries resultRun and delegatedWorkSettled (present only when honoured). A host wait sends it as an optional argument. The CLI (start --wait; send --wait to an idle thread) follows a completed run to the run its background work wakes, as upstream; a server that refuses or ignores the option gets the old behaviour.

## Left out

- ed57b9b5ec: McpToolAccess.afterForwarding and the peer/ handlers (GOAT routes host sends in HostThreadsMcpService); the per-run stop key and the shared-thread resultRun logic (each GOAT task row interrupts and waits on its own launched run id); upstream's peer tests (no peer module), adapted as below.
- 571b319643: failing the task (option A, not chosen); the peer test file.
- 671f85417c: none of the CLI; upstream's OrchestratorMcpToolkit.integration assertion extends a scenario GOAT does not have. The server half comes from upstream's 594f1ce2eb tests, carried into ThreadManagementService.delegatedWork.test.ts (ThreadManagementService.test.ts is at its budget).

## Fail-first (code before each fix)

- O9 orchestrator: DelegatedCompletionDelivery "a follow-up to a finished remote task registers after the parent's run ended": `OrchestratorDispatchError … Caused by: Remote task parent run is not active.` After: passes.
- O9 coordinator: RemoteDispatchCoordinator.followUp.test.ts, 4 failed: `TypeError: c.followUp is not a function`. After: 4 passed.
- O11: LaunchWatchService.follow.test.ts, 2 failed: `Test timed out in 120000ms` (the follower never waits again after the defect). After: 24 passed.
- C18 server: ThreadManagementService.delegatedWork.test.ts, 3 failed (corrected; see the follow-up round): `expected { …(3) } to match object`, resultRun missing. After: 3 passed (with the timeout negative case).
- C18 host: HostThreadsMcpService "a remote wait for delegated work passes the option only to a host that declares it": `expected { threadId: 'remote-1', …(2) } to not have property "untilDelegatedWorkSettled"`.
- C18 CLI: thread.test.ts 2 failed ("--wait lasts until background work …", "--wait waits out the moment …"). After: 14 passed.

## C4 cases

- O9 older server reading a row this one writes (downgrade): the row is a kind task, reports_supported 0 row with a launched run, the shape older servers already follow for hosts without reports; it follows goat_thread_wait and records the result into the registered task. Older host: the follow-up is an ordinary goat_thread_send there and is followed with goat_thread_wait, which every GOAT host serves; only its result summary falls back to the generic text. Older client: the send result's taskId was already optional. Negative: steer, no finished task, refused registration (tests above).
- C18 older server, newer CLI: the server refuses the undeclared argument; the CLI reports its own run's end (test "refuses the argument"), and the same when a server ignores it (no delegatedWorkSettled). Older host, newer server: the option goes as an optional argument, dropped for a host that does not declare it, so the answer lacks delegatedWorkSettled (HostThreadsMcpService test). Older client, newer server: never sends it; the wait is unchanged (first assertions of the delegatedWork test). Negative: honoured but the task still runs, so the wait times out with no resultRun.

## Gate

At `27ef9097b3` (integration `44d7d60d20` merged): goat-rename --check 0; `vp run check:changed` (Node 26.12.1): format, lint, knip 1/2 and 2/2, graphql, agent context budget, typecheck (39 packages) pass; agent surface audit failed as stale (fixed in `fa4899666f`, --check passes); test (1201 files, 19149 tests) 3 failed, all known: packages/ssh runtimeFactsScripts.test.ts (goat#3363), tunnel.client-session.test.ts (goat#3418, "Remote host is missing node on PATH" on rerun), AttachmentFilePreview.browser.test.tsx Mermaid toggle (goat#3560). None touch this lane's files. Focused suites at the head: 82 files, 1126 tests passed.

## Budgets

| entry                                         | before (integration) | after | real length |
| --------------------------------------------- | -------------------- | ----- | ----------- |
| apps/server/src/mcp/LaunchWatchService.ts     | 2049                 | 2023  | 2023        |
| apps/server/src/mcp/OrchestratorMcpService.ts | 3957                 | 3909  | 3909        |
| packages/contracts/src/orchestratorMcp.ts     | 1161                 | 1092  | 1092        |

RemoteDispatchCoordinator.ts 1261 of 1263 (unchanged entry), HostThreadsMcpService.ts 981, cli/thread.ts 938, LaunchWatchService.follow.test.ts 998 (default 1000). New files: remoteTaskFollowUp.ts, launchWatchFollower.ts, hostThreadLists.ts, scheduledTaskWebhookUrl.ts, orchestratorMcpCapabilities.ts, and three test files.

## Surfaces

- Entry points: O9 any goat_thread_send with host from a thread with a finished remote task (agents and goat_call); O11 every launch watch (local and remote); C18 goat_thread_wait for agents (thread.wait gains the parameter, description unchanged within budget; agent-surface-audit regenerated, context budget passes) and `goat thread start|send --wait`; docs/user/outside-agents.md says what --wait now waits for.
- Clients: no web, desktop or mobile change. Providers: none specific. Settings: none.

## Known limits

- A follow-up task does not import the remote agent's progress reports (they stay on the first task's report binding); its result is the run's reported summary, else "The launched remote run ended with status …".
- A follow-up whose run is restarted there is followed to its first run id only.
- The lost-track notice for a launch watch is one wake per run of failures; nothing marks the watch itself in goat_thread_status.
- A lost-track wake that fails to send is not retried.
- A watch with no launcher thread (an outside caller that gets reports through its completion webhook) gets no lost-track notice; that caller just stops getting reports for the thread until its next send or a GOAT restart follows it again.
- A remote task drain that fails again and again keeps the task running and retries, but never tells the parent it lost track (goat#3568).
- RemoteDispatchCoordinator's owners and locks maps keep an entry per dispatch, follow-ups included, for the life of the process (goat#3569, on dev before this lane).

## Review and follow-up round

Fresh final C4 review at `fa4899666f`: APPROVE WITH NITS, no P0, P1 or P2; seven P3 (report next-N8-review-fa489966.md). The lane is accepted at `fa4899666f` and held under the freeze until N3 lands. Coordinator rulings, verbatim:

> 1. N8-P3-1 (code, test first). remoteReports/remoteTaskFollowUp.ts:100 and :138. INSERT OR IGNORE becomes ON CONFLICT(correlation_id) DO NOTHING, so a CHECK or NOT NULL violation is an error again and not "a replay". When no row was inserted, the call must tell three cases apart, and each gets a test: (a) the follow-up task is already registered (a retry after a full success, whether its row is still running or has settled): return the same taskId, one task, no second registration; (b) no task is registered and the row is still running (a crash between the INSERT and the registration, retried before the remote run ended): register once, and the parent is woken once when the result arrives; (c) no task is registered and the row is no longer running (the drain settled the orphan row with an empty receipt): return the "not recorded" failure; never a task that runs forever. Fail-first for (c): today it registers a task that never ends.
> 2. N8-P3-2 (code, test first). mcp/launchWatchFollower.ts:84: the lost-track wake key uses the newest pending run (watch.pendingRuns.at(-1)), so a second run of failures after the agent's next goat_thread_send gives a second notice. Test: after the first notice, a later send whose follower also fails four times delivers a second lost-track wake. The two smaller gaps go under Known limits in the record, in plain words: a lost-track wake that fails to send is not retried; a watch with no launcher thread (an outside caller with a webhook) gets no lost-track notice (say what that caller sees instead).
> 3. N8-P3-3 (coordinator decision): ACCEPTED as the scope of O11. The decision sheet's O11 pointed at the launch watch follower, and the lane ported it there. RemoteDispatchCoordinator's task drains already retry with a bounded backoff (5 to 300 s) and leave the task non-terminal, which is what C asks for; what they lack is the notice. That is a follow-on, not this lane: file a goat issue "a remote task drain that fails N times in a row never tells the parent it lost track" (repro from the code, RemoteDispatchCoordinator.ts:920-937, the wording O11 C ruled, the fix: the same notice from a drain after N defects in a row, once per run of failures), send me the number, and put the sentence under Known limits.
> 4. N8-P3-4 (code, test first; a GOAT difference from upstream 594f1ce2eb, disclosed with this reason). With untilDelegatedWorkSettled set, once the selected run has ended the wait also releases on a pending question asked by a LATER run of that thread (a run that background work woke), returning its pendingRequestIds; today the wait holds to its timeout and returns timedOut with no request ids, so an agent waits up to an hour on a question it could answer. Conditions: the read stays narrow (pending user-input requests of the thread only; no whole-thread read, lane N7's read budgets stand); releaseOnPendingQuestion: false still suppresses it; ignoredRequestIds still apply; without the field the behaviour is exactly as on dev (a test pins that). If this needs more than a small change in ThreadManagementService.ts, put the logic in a GOAT-owned module with a thin hook; if it would change an existing test's expectation, stop and ask.
> 5. N8-P3-5 (docs). docs/user/outside-agents.md:310-313: say that --wait follows wakes for start --wait and for send --wait when the thread was idle when the message was sent; a send to a busy thread returns that turn's reply.
> 6. N8-P3-6 (record, and one hunk). Record: findLast here versus upstream's find (which finished task's model and title a follow-up copies) with the reason; the C18 server fail-first is 3 failures, not 2. The upstream Orchestrator.ts hunk that switches the local child follow-up to followUpOwnerRun: CARRY it, so the rule lives once (OrchestratorRunState) and the inline copy at Orchestrator.ts:8017-8019 goes, provided the behaviour is identical, no existing test expectation changes and Orchestrator.ts does not grow past its entry (13556 on the integration branch; it must not be raised); if any of the three fails, leave it out and say which in the record.
> 7. N8-P3-7 (issue). File a goat issue "RemoteDispatchCoordinator owners and locks grow for the life of the process" (RemoteDispatchCoordinator.ts:209-211, :948; pre-existing on dev; every dispatch and now every follow-up adds one entry to each; fix: delete both when a drain ends with its row no longer running; the resilience rule: every map the server holds has a limit). Send me the number; not fixed in this lane.

| item    | commit                                     | result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N8-P3-1 | `66cadbfc8318e75f3c38dee414d280a25f5220c5` | ON CONFLICT(correlation_id) DO NOTHING; cases (a) recorded task returned (row running and settled), (b) orphan running row registered once with one result, (c) orphan settled row gives "not recorded". Fail-first: (a) twice `expected [ {…}, {…} ] to have a length of 1 but got 2`, (c) the call returned a task; 3 failed of 7. After: 7 passed.                                                                                                                                                                                                                                                                           |
| N8-P3-2 | `512a95fe52`                               | key `lost-track:<incarnation>:<pendingRuns.at(-1)>`. Fail-first: the second notice replayed the first receipt, `Test timed out in 120000ms`. After: 3 passed. The defect tests moved unchanged to LaunchWatchService.followerDefects.test.ts (follow.test.ts was at 998 of 1000); goat-rename --check 0, no rule or TEST_TITLES entry names them.                                                                                                                                                                                                                                                                               |
| N8-P3-3 | goat#3568                                  | filed; Known limits below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| N8-P3-4 | `768d96cb8d`                               | new GOAT module orchestration-v2/threadWaitLaterQuestions.ts with a 15-line hook in waitForRun. Reads: the thread's pending runtime requests, then, only if one is a user-input question, the user_input_request items of the later runs. Fail-first: `expected { …(3) } to match object { timedOut: false, …(1) }` (got timedOut: true, no ids). After: 4 passed; the same test pins releaseOnPendingQuestion: false, ignoreRequestIds and the unchanged wait without the field. No existing expectation changed (ThreadManagementService.test.ts and ThreadManagementSettlement.test.ts, 77 tests with the split file, pass). |
| N8-P3-5 | `8eb2116b50`                               | docs/user/outside-agents.md                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| N8-P3-6 | `0ff08e8a04`                               | upstream's Orchestrator.ts hunk carried: the local child follow-up uses followUpOwnerRun. Same predicate (isBlockingRun) and fallback (latestExecutedRun), so identical; no expectation changed (12 DelegatedCompletion and related files, 63 tests, pass); Orchestrator.ts 13556 to 13555, entry lowered.                                                                                                                                                                                                                                                                                                                      |
| N8-P3-7 | goat#3569                                  | filed, not fixed here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Corrections to the sections above:

- findLast versus upstream's find: when a thread there backs several finished tasks of the caller (an earlier follow-up, say), the follow-up copies the model and title of the newest one, which is the one the agent last worked with; upstream copies the first.
- The C18 server fail-first is 3 failures of 3 at `44d7d60d20` (the timeout negative fails too), not 2.

Owed to #3519's integrated pass: a web and a mobile view of a parent with a finished remote task and its follow-up; one CLI transcript of `start --wait` and of `send --wait` to an idle thread; a live two-machine run of O9.

Residual the reviewer named: a send that reached the host before the server stopped, and before the INSERT, leaves no record and no wake; upstream has the same gap.

Focused tests for this round (pen-macmini, no check:changed while lane N9b gates there): RemoteDispatchCoordinator.followUp.test.ts 7; LaunchWatchService.followerDefects/follow/LaunchWatchService.test.ts 104; ThreadManagementService.delegatedWork/ThreadManagementService/ThreadManagementSettlement 77; DelegatedCompletion*, DelegatedSelfQueue, FinishedDelegateRelease 63; server typecheck clean.

NOT RUN: CI (ci:full); a live two-machine run of O9 and O11 (server-only rows: the runtime evidence is the test transcripts above); the desktop app; mobile; an independent C4 review lane.
