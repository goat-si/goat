# N8 Remote tasks and CLI wait (lane record)

Lane branch: `chase/t3-261114-n8-remote-tasks`, head `fa4899666f8e1c4c1b407ebbc9fa12d3cc05c299` (based on dev `26847e90dc`, merged with the integration branch at `44d7d60d20`; dev has nothing newer). Host pen-macmini (juniui-Macmini.local, macOS 27.0, 10 cores, Node 26.12.1). Rows from #3176: L132 (O9 A), L135 (O11 C), L215 (C18 A). C4: O9 (new stored dispatch records) and C18 (contract field).

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
- C18 server: ThreadManagementService.delegatedWork.test.ts, 2 failed: `expected { …(3) } to match object`, resultRun missing. After: 3 passed (with the timeout negative case).
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
- The lost-track notice for a launch watch is one wake; nothing marks the watch itself in goat_thread_status.

NOT RUN: CI (ci:full); a live two-machine run of O9 and O11 (server-only rows: the runtime evidence is the test transcripts above); the desktop app; mobile; an independent C4 review lane.
