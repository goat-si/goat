# Child and watched-thread wakes

This specification covers app-owned delegated tasks, launched/watched threads, question escalation, stop, and the parent mailbox. These are different v1 paths: a launched-thread watch is not necessarily a parent/child delegation. Trace expectations below are semantic proposals, not transcripts of a test run; status normalization and observing the provider acceptance boundary require a driver adapter.

Pinned v1: `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (`/tmp/goat-v1-916b5cc`).

## Rules

**R1.** A delegated task is finalized only for a subagent lineage with a parent and node fork; unless the result run is the task’s cancelled run, finalization waits for outstanding delegated work or restart continuation. OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:11467-11486`, `apps/server/src/orchestration-v2/Orchestrator.ts:11544-11555`; `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.followupSubagents.test.ts:22-23`.

**R2.** Finalization reads the child result and records terminal status and result on the parent's task and, if the corresponding turn item exists, on that item, plus a consumed context transfer identifying the source child and run. OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:11558-11577`, `apps/server/src/orchestration-v2/Orchestrator.ts:11624-11648`, `apps/server/src/orchestration-v2/Orchestrator.ts:11660-11680`, `apps/server/src/orchestration-v2/Orchestrator.ts:11745-11773`.

**R3.** The parent updates and completion reservation are written before offering the continuation; this is a durable-first reservation, not proof that the provider has consumed the message. OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:11683-11706`, `apps/server/src/orchestration-v2/Orchestrator.ts:11764-11782`, `apps/server/src/orchestration-v2/ProviderContinuationService.ts:163-193`.

**R4.** Each entry labels the task ID, with title and child thread ID when available, and status when the task exists. A non-null result is inlined only if the entire labeled result fits the remaining shared 16,000-byte inline budget; otherwise, including a missing result, the entry gives a `task.read` instruction. OBSERVED. `apps/server/src/orchestration-v2/delegatedCompletionWake.ts:3-25`.

**R5.** `settled_only` (the default in this planner) does not offer a completion while the spawning run is live; `always` can be offered while it is live. Changing the wake policy to `always` on a terminal task whose parent run is still live can plan a delivery; a duplicate policy or a non-owned task is rejected with the specific messages in the implementation. OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:11302-11313`, `apps/server/src/orchestration-v2/goat/DelegatedTaskWakePolicy.ts:54-95`.

**R6.** A completion is server-created as `queue_after_active`; under the lock it can be converted to a steer only when all included tasks have `completionWake: always`, there is a live provider turn and session, active steering is supported, steering does not interrupt tools, and Stop has not reached the run. This path never deliberately interrupts/restarts the turn for the notice. OBSERVED. `apps/server/src/orchestration-v2/ProviderContinuationService.ts:173-193`, `apps/server/src/orchestration-v2/Orchestrator.ts:5511-5573`.

**R7.** For an ordinary thread a completion may steer a different live run; a GOAT Bot session permits that only when the live run is the spawning run. Questions with a uniquely identified task owner use the same restriction. OBSERVED. `apps/server/src/orchestration-v2/goat/DelegatedCompletionRouting.ts:3-11`, `apps/server/src/orchestration-v2/Orchestrator.ts:5537-5556`; `apps/server/src/orchestration-v2/SteeringCompletion.sessionOwnership.integration.test.ts:30-38`.

**R8.** A queued completion delivery absorbs later sibling IDs and rewrites its text if the corresponding message exists; a blocking or terminal delivery run leaves racing siblings pending for a successor. A newly reserved cohort gets a generation and message ID. OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:11315-11388`, `apps/server/src/orchestration-v2/Orchestrator.ts:11415-11447`.

**R9.** Acknowledged, delivered, or disposed tasks are not re-offered; an archived/deleted parent, missing parent run, or closed cohort disposes the result's delivery. The existing child-to-parent result transfer also suppresses duplicate finalization. OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:11269-11300`, `apps/server/src/orchestration-v2/Orchestrator.ts:11609-11622`.

**R10.** A continuation dispatch checks the open cohort's generation and message ID and existing message before sending; a stale request is rejected as `Delegated completion delivery is no longer dispatchable.` A retry rechecks the reservation; if the retry check itself fails, the request is re-offered without a successful recheck. There is a special case for an undelivered mailbox steer: acceptance and receipt cannot commit atomically, so this is not a universal exactly-once provider guarantee. OBSERVED. `apps/server/src/orchestration-v2/ProviderContinuationService.ts:30-60`, `apps/server/src/orchestration-v2/ProviderContinuationService.ts:313-343`, `apps/server/src/orchestration-v2/Orchestrator.ts:5418-5456`, `apps/server/src/orchestration-v2/NotificationMailbox.ts:25-40`.

**R11.** A local child user-input question has a separate escalation message, including child/request identity and instructions to read the current question; the first answer wins and approvals remain human-only. Local question escalation can reach the launcher even when launch completion watching is disabled. OBSERVED. `apps/server/src/orchestration-v2/QuestionEscalationService.ts:99-127`, `apps/server/src/orchestration-v2/QuestionEscalationService.ts:312-337`, `apps/server/src/mcp/toolkits/orchestrator/tools.test.ts:15-18`.

**R12.** An updated question notice can take the guarded steer route; otherwise it goes through the queue. Agents cannot answer approval requests: the dispatch error says `Only the user or an approved MCP client can answer approval requests.` OBSERVED. `apps/server/src/orchestration-v2/Orchestrator.ts:5511-5573`, `apps/server/src/orchestration-v2/Orchestrator.ts:8027-8033`.

**R13.** `thread.launch` registers a completion watch unless `notifyOnCompletion` is false, for a caller or eligible external launch; the external case has no thread to wake and uses a webhook. OBSERVED. `apps/server/src/mcp/ThreadLaunchMcpService.ts:749-770`, `apps/server/src/mcp/ThreadLaunchMcpService.ts:782-785`, `apps/server/src/mcp/launchWatch.ts:27-30`.

**R14.** An ordinary watched run-end wake contains thread and host identity, run status, optional branch/worktree, up to four nonblank lines and 400 characters of the last message, and `thread.read`/`thread.unwatch` directions; notification summary is bounded to 120 characters. A failed run with no excerpt and structured failure uses a separate failure wake with `thread.status` rather than `thread.read`. This is distinct from the delegated task’s 16,000-byte inline budget. OBSERVED. `apps/server/src/mcp/launchWatch.ts:252-255`, `apps/server/src/mcp/launchWatch.ts:735-756`, `apps/server/src/mcp/launchWatch.ts:793-833`, `apps/server/src/mcp/launchWatch.ts:875-930`, `apps/server/src/orchestration-v2/delegatedCompletionWake.ts:3-25`.

**R15.** Watch notifications use a server-created queued message; deterministic watch/event command and message IDs turn crash replay into receipt replay. A failed attempt may deliberately get new IDs, so distinguish a failed attempt from replaying an accepted one. OBSERVED. `apps/server/src/mcp/threadWake.ts:8-29`, `apps/server/src/mcp/launchWatch.ts:342-359`, `apps/server/src/mcp/launchWatch.ts:759-781`.

**R16.** A watch question wake identifies the request and points to `pending_request.read` and `pending_request.respond` for user input; approval text directs the user to a client. The opt-out guide says unwatch/false stops run-end and host-outage reports, while local user-input questions still arrive; remote questions must then be discovered separately. OBSERVED. `apps/server/src/mcp/launchWatch.ts:933-961`, `apps/server/src/mcp/toolkits/orchestrator/tools.test.ts:15-18`.

**R17.** A host outage is reported after three failed contacts once per outage episode; the wake says `host_unavailable`, that retries continue, and that the remote thread may still be running. This is not evidence that the child failed or stopped. OBSERVED. `apps/server/src/mcp/launchWatch.ts:248-248`, `apps/server/src/mcp/launchWatch.ts:669-699`, `apps/server/src/mcp/launchWatch.ts:965-978`.

**R18.** A failed run with no excerpt and non-null failure details gets a separate failure wake; ordinary terminal wakes carry status and, when available, branch or worktree location. The watch's local/remote waiting timeout is a monitoring interval, not by itself a child terminal outcome. OBSERVED. `apps/server/src/mcp/launchWatch.ts:803-820`, `apps/server/src/mcp/launchWatch.ts:875-926`, `apps/server/src/mcp/LaunchWatchService.ts:119-123`, `apps/server/src/mcp/LaunchWatchService.ts:480-501`.

**R19.** Stopping a parent run is not equivalent to stopping its entire thread: the test pins async delegated work surviving a run Stop, whereas thread Stop walks app-owned unpromoted descendants, including descendants with pending work. The walk attempts siblings and returns its first failure; its outbox execution has a 30-second timeout. OBSERVED. `apps/server/src/orchestration-v2/ThreadStop.test.ts:399-399`, `apps/server/src/orchestration-v2/ThreadStop.test.ts:481-481`, `apps/server/src/orchestration-v2/ThreadStop.test.ts:1390-1391`, `apps/server/src/orchestration-v2/StopDelegatedTasks.ts:19-45`, `apps/server/src/orchestration-v2/StopDelegatedTasks.ts:75-95`, `apps/server/src/orchestration-v2/goat/EffectExecution.ts:47-49`, `apps/server/src/orchestration-v2/goat/EffectExecution.ts:69-80`.

**R20.** Stopping a completion wake can dispose its cohorts, and late results must not revive them. An active delegated task can still be a future wake only while its parent is live in the relevant delivery sense and the cohort is open. OBSERVED. `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts:130-131`, `apps/server/src/orchestration-v2/delegatedTaskWake.ts:8-29`.

**R21.** A bot's report is refused with `delegates_pending` while owned delegates hold completion; the host records that a report is due. Reports are independently stored per thread/run, with `run_mismatch`, `run_not_found`, `deliverables_pending`, `attachment_invalid`, and `attachment_limit` possible on the shown paths; a report is not itself proof of a successful check. OBSERVED. `apps/server/src/threadResults/delegatedBotReports.ts:17-73`, `apps/server/src/threadResults/ThreadResultService.ts:171-183`, `apps/server/src/threadResults/ThreadResultService.ts:265-290`, `apps/server/src/threadResults/ThreadResultService.ts:293-318`, `apps/server/src/threadResults/ThreadResultService.ts:334-351`.

**R22.** Channel-owned child admission shares depth and capacity enforcement across delegation and launch; it maps `depth_exceeded` to `capability_denied` and `at_capacity` to `capacity_exceeded`. The bridge says ordinary callers bypass this channel admission, so these codes do not establish a universal v1 depth limit. OBSERVED. `apps/server/src/mcp/childWorkAdmission.ts:1-5`, `apps/server/src/mcp/childWorkAdmission.ts:25-32`, `apps/server/src/mcp/childWorkAdmission.ts:45-73`.

## Capability flags

- `turns.supportsActiveSteering` and `turns.activeSteeringInterruptsTools` directly gate the guarded notice steer in R6; Codex sets the former true and omits the latter, which passes the `!== true` test. OBSERVED. `packages/contracts/src/providerCapabilityParts.ts:103-118`, `apps/server/src/orchestration-v2/Orchestrator.ts:5562-5572`, `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:22-32`.
- Codex also declares queued messages, interrupt and interrupt-restart support, but R6 explicitly does not use interruption as a notice fallback. OBSERVED. `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:22-32`, `apps/server/src/orchestration-v2/Orchestrator.ts:5511-5513`.
- Codex declares structured questions and subagent-origin approvals; these are provider capabilities, not a grant for an agent to approve. OBSERVED. `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:49-69`, `apps/server/src/orchestration-v2/Orchestrator.ts:8027-8033`.

## Existing v1 tests and fixtures

- `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts:275-275` covers batched acceptance; `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts:815-815` covers rewriting/cancelling a queued wake after acknowledgement; `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.checkpointRetry.test.ts:31-34` covers retry. These are testkit-driven cases, not evidence of an executed replay in this research.
- `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.restart.test.ts:32-33` covers a child result queued across restart, and `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.restart.test.ts:390-390` covers an interrupted monitor. No tests were run here.
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts:31-87` supports dispatch, held-run completion, run-status and steerable gates. `apps/server/src/orchestration-v2/testkit/SteeringHarness.ts:32-60` supplies controllable steering capabilities and captured inputs.
- `apps/server/src/orchestration-v2/testkit/ThreadLaunchHarness.ts:69-75` disables actual provider execution; `apps/server/src/orchestration-v2/testkit/ThreadLaunchHarness.ts:126-135` builds a replay harness without the effect worker. Do not claim it alone executes a full wake.
- `apps/server/src/orchestration-v2/testkit/QueuedWatchWakeAssertion.ts:16-79` is specifically a **pull-request** watch queued behind a run, not a thread-watch scenario; its held-wake auto-settlement case is `apps/server/src/orchestration-v2/testkit/QueuedWatchWakeAssertion.ts:82-125`.
- Codex recordings exist at `apps/server/src/orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson:1`, `apps/server/src/orchestration-v2/testkit/fixtures/subagent_v2/codex_transcript.ndjson:1`, and `apps/server/src/orchestration-v2/testkit/fixtures/subagent_v2_nested_approval/codex_transcript.ndjson:1-5`. Their existence does not prove that they replay the proposed MCP lifecycle without additional scripted stimuli.

- OBSERVED: The recorded multi-thread MCP integration driver reads `delegated_task_status` and exercises a delegated child and cross-thread send, including a queued request delivered as steer: `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts:104-123`, `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts:375-389`, `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts:453-467`, `apps/server/src/orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson:1`. Reuse for the proposed wake scenarios requires compatibility and stimulus verification; this work ran no replay.

## GOAT 2 mapping

OBSERVED: Owner decisions establish 15 intended log events (14 existing contract variants plus `input.changed`, pending implementation) and Part 1 MCP `thread.report_result`; `thread.watch` and agent MCP queue.* are deferred (`goat2-design/prd-src/decisions.md:69-73`, `goat2/crates/goat2-contracts/src/log.rs:65-119`). This table is a design mapping, not runtime certification.

| v1 rule | v1 observable | Part 1 status (same / deliberate difference / deferred / pending) | GOAT 2 evidence (log event or command/MCP reply) | coverage (scenario name or source-only) |
|---|---|---|---|---|
| R1–R4 | Durable parent result, completion payload | deliberate difference: 8 KB final text plus location (`goat2-design/prd-src/part1/runtime.md:93-96`) | `child.started`, `child.reported`, `input.accepted` | active_child_completion_steers |
| R5–R10 | Cohort reservation, routing, coalescing, delivery | pending: cohort and recovery metadata | `input.accepted`, `input.delivered`, `run.started` | queued_siblings_coalesce, idle_failure_wakes_once_after_retry |
| R11–R12 | Local question notice and answer | pending: notice policy | command/MCP reply, `input.accepted` | local_question_opt_out |
| R13–R18 | Watch completion, question and outage | deferred: thread.watch | MCP reply; no watch wake yet | source-only |
| R19–R20 | Run Stop versus thread Stop, disposal | same for run Stop; thread Stop and disposal details pending | `run.finished`, command reply, child transitions | stop_run_vs_thread |
| R21–R22 | Report refusal and scoped child admission | Part 1 includes report_result; refusal parity pending verification; child limits deliberately differ | MCP reply, `child.reported` | source-only |
| Restart | v1 cancelled plus server_restart; queued inputs re-held | deliberate difference: GOAT 2 interrupted when `run.accepted` or an item exists; otherwise unknown; queued inputs remain | `run.accepted`, `run.finished`, `child.reported` | source-only |

OBSERVED: Part 1 has no interrupt demotion; Stop holds the queue, stops wait-mode delegated children and leaves async children running to report later (`goat2-design/prd-src/part1/runtime.md:65-69`). Thread Stop is a distinct v1 descendant walk (`apps/server/src/orchestration-v2/StopDelegatedTasks.ts:19-45`). Restart settlement is an intentional difference (`goat2-design/prd-src/part1/runtime.md:98-105`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:379-496`). Admission refusal fails closed. A start onto an unowned native turn steers and adopts when allowed; otherwise, or if refused or unconfirmed, it fails without resend (`apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:113-194`). After admission, same-ID delegated completions, notifications and tagged declines re-dispatch `queue_after_active`; an ordinary missed steer of an ended turn uses `start_immediately` (`apps/server/src/orchestration-v2/EffectWorker.ts:310-360`). Codex turn/steer RPC errors are `ProviderAdapterSteerRunError` and are not re-queued by EffectWorker; the final v1 outcome is pending `steer_rpc_error_codex` replay (`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:7315-7360`, `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:540-570`).

## Parity scenarios

OBSERVED (runnable): scenario child_wake_delegated (goat2-parity crate) is a real v1 Codex recording (codex-cli 0.167.0 through the OpenCodex pool, 2026-11-29, isolated Codex home, scrubbed). P starts a turn, calls `task.create` with `mode: async` while it runs (the caller must own a live run, `apps/server/src/mcp/OrchestratorMcpService.ts:677-702`), and finishes; C finishes after P is idle. The async task carries `completionWake: always` (`apps/server/src/mcp/OrchestratorMcpService.ts:2103`); because P is no longer live, the completion is planned at once (`apps/server/src/orchestration-v2/Orchestrator.ts:11302-11313`), dispatched `queue_after_active` (`apps/server/src/orchestration-v2/ProviderContinuationService.ts:173-193`) and, with P idle, starts P's second run directly without a queued state. The message inlines C's result (`apps/server/src/orchestration-v2/delegatedCompletionWake.ts:3-25`) and gets no user turn item, so the v1 trace gives the child input the mode that happened (`start`). Trace on v1: `child.reported c1 completed`, `input.accepted c1#1 from child mode start`, `run.started r2 [c1#1]`, `parent.woken w1 started r2`, `run.finished r2 done`; it replays with 14 outbound frames checked and the stream fully consumed.

INFERRED: These proposed traces use thread aliases P, C, C1 and C2 and are scoped slices, not executed results. `child.reported` projects a v1 durable result. `parent.woken` uses a correlated wake alias: queued requires a v1 wake run observed queued; started requires it running; steered requires proven delivery; cancelled requires a cancelled wake run. GOAT 2 queued wake remains pending, since requested input mode alone is not proof. GOAT 2 watch wake is deferred. Optional `text` asserts exact content when present.

### `active_child_completion_steers`

Setup: ordinary P running with live steerable Codex turn; C is an app-owned task with `completionWake=always`.

Steps: agent calls `task.create`; let C finish with a small final answer while P remains active.

Expected: `tool.result {thread:P,call:c1,path:task.create,status:ok}` → `child.started {thread:P,child:C}` → `run.started {thread:C,run:r1,inputs:[task]}` → `run.finished {thread:C,run:r1,status:done}` → `child.reported {thread:P,child:C,status:done}` → `input.accepted {thread:P,input:i1,from:child,mode:steer}` → `steer.applied {thread:P,run:r1,input:i1}` → `parent.woken {thread:P,child:C,wake:w1,state:steered,run:r1}`.

Driver: OrchestratorScenario dispatch plus SteeringHarness-style controlled session; MCP creation needs a handler bridge; assert actual provider steer success and correlate `wake:w1` with `r1`. Candidate transcript: `delegated_task_status`; verify compatibility before reuse.

### `queued_siblings_coalesce`

Setup: P has a blocking active turn without safe active steering; two always-wake tasks belong to the same spawning run.

Steps: create C1 and C2, finish both before P's turn ends, then finish P's active turn.

Expected: `child.started {thread:P,child:C1}` → `child.started {thread:P,child:C2}` → `run.finished {thread:C1,run:r1,status:done}` → `child.reported {thread:P,child:C1,status:done}` → `input.accepted {thread:P,input:i1,from:child,mode:queue}` → `queue.changed {thread:P,input:i1,op:enqueued}` → `parent.woken {thread:P,child:C1,wake:w1,state:queued}` → `run.finished {thread:C2,run:r1,status:done}` → `child.reported {thread:P,child:C2,status:done}` → `queue.changed {thread:P,input:i1,op:edited}` → `run.finished {thread:P,run:r1,status:done}` → `run.started {thread:P,run:r2,inputs:[i1]}` → `parent.woken {thread:P,child:C1,wake:w1,state:started,run:r2}`. Supply the exact edited fixture text in a real expectation; GOAT 2 queued state is pending.

Driver: delegated completion testkit plus command dispatch; queued message rewrite is implemented at `apps/server/src/orchestration-v2/Orchestrator.ts:11315-11388`; the test at `apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts:275-365` instead covers a subsequent generation after acceptance. Candidate transcript: `delegated_task_status`, pending compatibility check.

### `idle_failure_wakes_once_after_retry`

Setup: spawning run has ended, C fails; arrange a retriable offer/dispatch failure and retain its reservation.

Steps: finish C as failed, retry delivery. Separately exercise replay after a recorded receipt and a crash before recording the receipt.

Expected: `run.finished {thread:C,run:r1,status:failed}` → `child.reported {thread:P,child:C,status:failed}` → `input.accepted {thread:P,input:i1,from:child,mode:queue}` → `run.started {thread:P,run:r2,inputs:[i1]}` → `parent.woken {thread:P,child:C,wake:w1,state:started,run:r2}` ; after recorded receipt, replay must not create a second acceptance. For a crash before receipt, provider acceptance may be unknown: do not resend, and keep the outcome pending until reconciled. The two branches must not be conflated.

Driver: `DelegatedCompletionDelivery` restart/checkpoint retry harness; candidate transcript `delegated_task_status`, requiring fault injection and compatibility validation.

### `local_question_opt_out`

Setup: P launches C with `notifyOnCompletion:false`; P has an active run that is not steerable when C's question arrives, so the guarded steer path cannot take it and the notice is queued (`apps/server/src/orchestration-v2/Orchestrator.ts:5511`); C asks a local user-input question. With a steerable P run the same question may be delivered by steer instead, which is a different scenario.

Steps: call `thread.launch`, trigger the question, read and answer it with `pending_request.read` / `pending_request.respond`, then finish C.

Expected: `tool.result {thread:P,call:c1,path:thread.launch,status:ok}` → `run.started {thread:C,run:r1,inputs:[task]}` → `input.accepted {thread:P,input:i1,mode:queue}` → `parent.woken {thread:P,child:C,wake:w1,state:queued}` → `tool.result {thread:P,call:c2,path:pending_request.read,status:ok}` → `tool.result {thread:P,call:c3,path:pending_request.respond,status:ok}` → `run.finished {thread:C,run:r1,status:done}`; no completion-watch wake. Assert `notification.source.kind=question` and observe the actual queued wake run; GOAT 2 queued is pending. A launched thread does not imply `child.started`.

Driver: MCP handler and QuestionEscalationService harness; `ThreadLaunchHarness` alone disables provider execution. Candidate `subagent_v2_nested_approval` demonstrates a provider-native approval, not this local app-owned question; a new scripted fixture is required.

### `stop_run_vs_thread`

Setup: P has an async delegated C and a running parent turn.

Steps: interrupt the parent run, observe C remains active; then explicitly stop P's thread and let the delegated-stop walk complete.

Expected: `child.started {thread:P,child:C}` → `run.started {thread:C,run:r1,inputs:[task]}` → `run.finished {thread:P,run:r1,status:interrupted}` . Independently observe `tool.result {thread:A,call:c1,path:thread.stop,status:ok}` and `run.finished {thread:C,run:r1,status:interrupted}` without assuming their relative order; then verify the final state. A is an authorized separate caller. The async child survives run Stop; the subsequent thread Stop walks eligible descendants. No completion wake is required after disposal.

Driver: thread-stop harness and MCP handler; no existing Codex transcript established for this stop cascade. `apps/server/src/orchestration-v2/ThreadStop.test.ts:481-481`, `apps/server/src/orchestration-v2/ThreadStop.test.ts:1390-1391`.

## Open questions

- Which GOAT 2 event metadata durably represents a reserved cohort, provider acceptance, acknowledgement and disposal across a crash without changing the listed event vocabulary?
- What is the exact GOAT 2 policy for v1 `settled_only`, watched-thread excerpts and local questions when `notifyOnCompletion` is false? The Part 1 parent-wake diagram does not settle these cases.
- The exact v1 numeric depth policy outside channel-owned admission and the precise child-result extraction rules for each failed/timeout outcome were not established in this pass; do not infer a global limit or timeout from R18/R22.
- Which listed recorded Codex fixtures can actually be replayed unchanged with each proposed MCP stimulus? Fixture existence was checked, but replay compatibility was not run or proven.
