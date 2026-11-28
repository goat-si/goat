# Restart settlement and recovery

This spec describes process-loss reconciliation, queued inputs, unread steering, child results, provider continuity, and late writes in the pinned GOAT v1 source. Statuses below are v1 projection statuses unless a semantic trace explicitly says otherwise; scenarios are proposed comparisons, not tests run in this investigation.

Pinned v1: `goat-si/goat` commit `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (read-only export `/tmp/goat-v1-916b5cc`).

## Rules

### R1. Ordinary local work is cancelled

OBSERVED — Startup reconciliation marks selected nonterminal runs `cancelled` with `terminationCause.kind = server_restart`; orderly shutdown uses `server_shutdown`. Attempts, nodes, and provider turns are also cancelled, streaming messages are closed, and most unfinished items are cancelled; this is not v1's `interrupted` or `unknown` run status.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:269-269`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:379-496`; `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.terminationCause.test.ts:19-19`.

### R2. Not all active-looking work is cut

OBSERVED — Cloud-task runs with a cloud execution session are removed from the local recovery projection. A never-attempted original start and a waiting run with a pending or running checkpoint capture are preserved; selected deferred resends are also excluded from cancellation.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:108-159`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:160-230`.

### R3. Restart notice is visible

OBSERVED — For reconciled nonqueued runs, except the usage-recovery unsent case, recovery adds a completed system notice titled `Server restarted` or `Server shut down`; its detail says the provider work was cancelled before completion. The previous partial streaming message stops streaming.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:269-269`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:452-464`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:498-508`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryItems.ts:44-78`.

### R4. Queued and unaccepted inputs are held

OBSERVED — Recovery puts ordinary queued runs into a held queue in delivery order. Starting/running runs without acceptance, a provider turn for the active attempt, or a pending request on their own run can be moved back to a held queue if their message is a human input or eligible unattended input; their user item becomes pending `queued_turn` and their running attempt/root node is reset to pending.

Refs: `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:28-43`, `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:58-77`, `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:79-132`, `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:169-195`; `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.test.ts:23-36`.

### R5. Recovery park is actionable

OBSERVED — For an unattended starting input parked by recovery, the system creates a waiting warning: `Recovery needs your decision before this message can be sent again.` Buffered provider notifications and delegated-completion messages have separate treatment and must not be assumed to follow the ordinary input path.

Refs: `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:55-76`, `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:111-115`, `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:134-167`; `apps/server/src/orchestration-v2/RecoveryParkedHold.integration.test.ts:193-193`.

### R6. Delivery evidence is monotonic

OBSERVED — New pending attempts default to `inputDelivery: unsent`; persisted `accepted` and `ambiguous` evidence is retained across older or partial updates, and an old server's apparent execution without a delivery marker can convert `unsent` to `ambiguous`. A missing active attempt during an admission update is an error, `Active attempt missing at provider input admission.`

Refs: `apps/server/src/orchestration-v2/AttemptInputDelivery.ts:26-33`, `apps/server/src/orchestration-v2/AttemptInputDelivery.ts:36-72`, `apps/server/src/orchestration-v2/AttemptInputDelivery.ts:76-90`.

### R7. Automatic resend is narrow, not general

OBSERVED — Startup's deferred resend selection requires every recorded attempt to say `unsent`, no provider turn for the active attempt in the projection and no matching turn for any recorded attempt in queried history, no pending request on the run, an enabled continuation setting, and an eligible scheduled or agent/MCP message with an original start and remaining budget. A non-scheduled human message, notification, or delegated-completion message is not selected by this path; a historical matching provider turn is treated as acceptance evidence instead.

Refs: `apps/server/src/orchestration-v2/goat/SelectRecoveryResends.ts:24-61`, `apps/server/src/orchestration-v2/goat/SelectRecoveryResends.ts:62-92`; `apps/server/src/orchestration-v2/RecoveryStartIdentity.test.ts:13-13`, `apps/server/src/orchestration-v2/RecoveryResendCapacity.test.ts:16-16`.

### R8. A previously unattempted durable start is different

OBSERVED — A `starting` run whose original `provider-turn.start` outbox effect was never attempted is preserved, excluding effects named as recovery resends. This is a durable effect replay case, not proof that every in-flight prompt is safe to resend.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:160-183`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:204-207`.

### R9. Unread steers are requeued, with an explicit-stop exception

OBSERVED — Pending steer and promoted-queue-to-steer items on terminal runs are recovered using their saved message and dispatched as `queue_after_active`; they are sorted by the earlier queue boundary and item ordinal. If an interrupt request exists on the run, the steer is cancelled instead, with `Steer delivery not confirmed` and a notice that it may not have been delivered and can be resent.

Refs: `apps/server/src/orchestration-v2/ProjectionRecoveryCandidates.ts:24-35`, `apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:28-57`, `apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:58-106`, `apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:108-155`; `apps/server/src/orchestration-v2/SteeringReceiptReplay.integration.test.ts:24-24`.

### R10. Requeue recovery is best effort

OBSERVED — Recovery processes unread-steer candidates under a thread lock; failure to inspect a thread or dispatch a message is logged rather than causing a successful delivery receipt to be invented.

Refs: `apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:131-164`, `apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:169-195`.

### R11. Native background work may need a continuation note

OBSERVED — Reconciliation records cancelled provider-native subagents and eligible background work against the last started provider-thread run. It persists a separate `run.background-work-cancelled` event; a continuation prompt warns the agent to check whether state-changing work already took effect before repeating it.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:466-496`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:663-681`, `apps/server/src/orchestration-v2/RestartContinuation.ts:40-41`; `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts:243-249`.

### R12. Continuation is conditional

OBSERVED — At startup, a project with `continueThreadsAfterServerUpdate` enabled can schedule a `provider-runtime.continue` effect if automation is not held and the selected source passes continuation eligibility. Eligibility includes a strong native thread identity, matching provider/thread/session ownership, and, for an active run, a running provider turn; archived/deleted/snoozed/settled threads and certain unresolved requests block it.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:683-705`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:805-808`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:868-870`, `apps/server/src/orchestration-v2/RestartContinuation.ts:69-114`, `apps/server/src/orchestration-v2/RestartContinuation.ts:143-212`; `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.automationHold.test.ts:25-25`.

### R13. App-owned child work has its own settlement

OBSERVED — Parent recovery leaves app-owned delegation nodes, rows and items open for the child to settle; blocking parent waits on a cut run are converted from `settled_only` to `always` wake. Recovery selects eligible terminal child runs with an unresolved parent task or missing result transfer and attempts finalization under the parent lock; failures are logged. This is not an unconditional fabricated `interrupted_by_restart` report for every running child.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:262-268`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:413-417`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:511-532`, `apps/server/src/orchestration-v2/ProjectionRecoveryCandidates.ts:38-76`, `apps/server/src/orchestration-v2/goat/RecoverTerminalSubagents.ts:6-33`; `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:895-895`, `apps/server/src/orchestration-v2/ProjectionRecovery.test.ts:509-509`.

### R14. Surviving Codex turns are adopted

OBSERVED — Survivor-family runs, attempts, nodes, provider threads and turns are excluded from ordinary cleanup. The restart test adopts the still-running native turn into a continuation without a new `turn/start`, retains the native turn ID, closes the source run as cancelled, and waits to send a queued start until the survivor completes.

Refs: `apps/server/src/orchestration-v2/SurvivorRecoveryProjection.ts:12-24`, `apps/server/src/orchestration-v2/SurvivorRecoveryProjection.ts:81-112`; `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:380-411`, `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:435-457`, `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:492-501`, `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:522-537`.

### R15. Uncertain survivor loss fails closed

OBSERVED — In the survivor restart test, loss of the verified process fails the continuation once; unverified loss or possible leftovers blocks new admission, with no extra continuation scheduled. The displayed error distinguishes `The Codex process stopped while the turn that ran across the restart was still running.` from `GOAT could not confirm the Codex process from before the restart stopped.`

Refs: `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:468-490`, `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:526-533`.

### R16. Session resume is distinct from turn continuation

OBSERVED — The Codex replay recovery test runs one message to idle, recreates the orchestrator using the same persistent database, and sends a second message with startup recovery; it asserts two completed runs and one provider thread. This establishes continuity of the provider-native thread across runtime recreation, not survival of an in-flight turn or an unconditional fresh thread.

Refs: `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts:275-283`, `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts:301-313`, `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts:326-369`.

### R17. Request recovery depends on callback kind

OBSERVED — Pending live-callback user questions with a matching persisted question item containing nonempty question text can change to message response capability, except on provider-native subagent threads. Other pending non-message requests expire on startup or cancel on shutdown with a not-resumable reason; an already-message response remains outside that cancellation set.

Refs: `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:231-260`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:351-377`; `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:34-34`.

### R18. Some writes are fenced by run identity

OBSERVED — `writeIfRunCurrent` checks run status and active attempt inside the write transaction and commits nothing if either changed; a separate provider-thread write checks active attempt and last run ordinal. Cleanup also uses a separate background-work event to avoid stale run snapshots overwriting later lifecycle changes.

Refs: `apps/server/src/orchestration-v2/EventSink.ts:401-433`, `apps/server/src/orchestration-v2/EventSink.ts:493-518`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:663-680`.

INFERRED — These are specific stale-write guards, not evidence that every provider output is fenced by one global host epoch. A universal v1 epoch guarantee is unresolved.

## Capability flags

- OBSERVED — `sessions.executionLocation` defaults to `local`, and drives the cloud exclusion in R2. `pendingRequestsSurviveRestart` and optional `ownsProcess` describe session capabilities. Refs: `packages/contracts/src/providerCapabilityParts.ts:66-85`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:108-120`.
- OBSERVED — Codex sets `pendingRequestsSurviveRestart: false`, native thread IDs and snapshot/rollback support, and supports native resume, active steering, interrupt and queued messages; `terminalStatusQuality` is `strong`. Refs: `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:3-32`, `packages/contracts/src/providerCapabilityParts.ts:89-120`.
- OBSERVED — `supportsNativeResume` describes continuing an interrupted turn without a new message; do not equate it with `thread/resume` of a provider conversation or survivor adoption. Ref: `packages/contracts/src/providerCapabilityParts.ts:103-110`.

## Existing v1 tests and fixtures

- OBSERVED — `OrchestratorReplayRecovery.integration.test.ts` splits the `provider_thread_resume` Codex transcript over two runtimes and asserts the persisted provider thread; refs: `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts:79-79`, `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts:275-369`.
- OBSERVED — `CodexSurvivorRestart.integration.test.ts` uses a controlled native-survivor harness, including lost, unknown, leftovers, and queued-start cases; it is not the `provider_thread_resume` Codex transcript. Ref: `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:522-537`.
- OBSERVED — The background-note replay uses a Claude fixture and tests restart-cancelled subagents; the slash-command case defers the note. Refs: `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts:22-47`, `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts:243-249`, `apps/server/src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts:303-308`.
- OBSERVED — Queue recovery covers queued, preparing, starting, own/other request, scheduled and delegated cases. Ref: `apps/server/src/orchestration-v2/RecoveryUnstartedQueue.test.ts:23-36`.
- OBSERVED — Fixture registry names `multi_turn_restart` and `turn_interrupt_restart` with Claude transcripts and `thread_rollback_after_restart` with a Codex transcript. `turn_interrupt_restart` is an interrupt/restart fixture, not by itself evidence of process-crash recovery. Refs: `apps/server/src/orchestration-v2/testkit/fixtures/index.ts:1341-1346`, `apps/server/src/orchestration-v2/testkit/fixtures/index.ts:1700-1706`, `apps/server/src/orchestration-v2/testkit/fixtures/index.ts:1740-1746`.
- OBSERVED — Recovery candidate and parent-result tests are separate from the Codex replay: `apps/server/src/orchestration-v2/ProjectionRecovery.test.ts:509-509`, `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:895-895`.

## GOAT 2 mapping

OBSERVED: Part 1 has 15 planned log events: 14 currently in `goat2/crates/goat2-contracts/src/log.rs:62-94`, plus owner-approved `input.changed` (`goat2-design/prd-src/decisions.md:73`). This durable log is distinct from the semantic trace below.

| v1 rule | v1 observable | Part 1 status (same / deliberate difference / deferred / pending) | GOAT 2 evidence (log event or command/MCP reply) | coverage (scenario name or source-only) |
|---|---|---|---|---|
| R1–R3 | OBSERVED cancelled, server_restart and notice | deliberate difference | INFERRED from `goat2-design/prd-src/part1/runtime.md:98-105`: `run.finished` interrupted with acceptance or items, unknown otherwise; no automatic resend | accepted_turn_restart_settlement |
| R4–R8 | OBSERVED eligible unaccepted inputs re-held; restricted resend exceptions | deliberate difference | INFERRED not-yet-started queued inputs remain queued; a run with only `run.started` and no acceptance or item is settled as unknown and blocks until human choice; no automatic resend of uncertain run (`goat2-design/prd-src/decisions.md:69`; `goat2-design/prd-src/part1/runtime.md:100-105`) | unstarted_and_waiting_queue_restart |
| R9–R10 | OBSERVED unread steer recovered or cancelled on explicit Stop | pending | `input.changed` queue mutation; delivery evidence and recovery policy pending | unread_steer_after_restart |
| R11–R12 | OBSERVED background cancellation note, conditional continuation | pending | Local work ends on exit; GOAT 2 policies for background cancellation notes and conditional continuation need separate evidence (`goat2-design/prd-src/part1/runtime.md:98-109`) | source-only |
| R13 | OBSERVED separate child settlement and recovery scan | deliberate difference | `child.reported` interrupted_by_restart, followed by parent input; transition evidence required (`goat2-design/prd-src/part1/runtime.md:83-94`, `goat2-design/prd-src/part1/runtime.md:104-105`) | delegated_child_recovery_wakes_parent |
| R14–R16 | OBSERVED survivor adoption and separate idle session resume | deliberate difference / pending | Survivor adoption of an in-flight local turn is excluded; subsequent session resume of an ended provider thread needs separate policy and evidence (`goat2-design/prd-src/part1/runtime.md:98-109`) | surviving_codex_turn_then_queue; resume_completed_provider_thread |
| R17 | OBSERVED request handling depends on callback kind | pending | `request.opened`, `request.resolved`; recovery policy pending | source-only |
| R18 | OBSERVED specific run/attempt and thread fences | deliberate difference | INFERRED generation fencing (`goat2-design/prd-src/part1/runtime.md:107-107`) | source-only |

## Parity scenarios

INFERRED test expectations below use the 020 semantic trace, not the durable log. Aliases T/P/C, i1–i3, r1–r3 and w1 denote distinct identities. Optional text is shown where relevant. V1 and GOAT 2 outcomes remain distinct; the scenarios are proposed, not executed.

### `accepted_turn_restart_settlement`

OBSERVED source oracle: v1 reconciles a selected active run to cancelled with server_restart (`apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:379-496`). Set up a local accepted run with a completed item and no survivor, then restart. Expected common prefix: `input.accepted {thread: T, input: i1, from: user, mode: start, text: "first"}`, `run.started {thread: T, run: r1, inputs: [i1]}`, `host.restarted {thread: T}`. V1 expects `run.finished {thread: T, run: r1, status: cancelled, cause: server_restart}`; GOAT 2 expects `run.finished {thread: T, run: r1, status: interrupted}`. Separately assert no automatic resend. Driver: a new controlled recovery harness is needed; the existing test at `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts:84-110` preserves a waiting run.

### `unstarted_and_waiting_queue_restart`

OBSERVED v1 re-holds eligible unaccepted and queued inputs (`apps/server/src/orchestration-v2/RecoveryUnstartedQueue.ts:79-132`). Set up i1 as a not-yet-started queued input (before `run.started` in GOAT 2) and two queued inputs; restart, then release explicitly. INFERRED trace: `input.accepted {thread: T, input: i1, from: user, mode: start, text: "first"}`, `input.accepted {thread: T, input: i2, from: user, mode: queue, text: "second"}`, `queue.changed {thread: T, input: i2, op: enqueued, text: "second"}`, `input.accepted {thread: T, input: i3, from: user, mode: queue, text: "third"}`, `queue.changed {thread: T, input: i3, op: enqueued, text: "third"}`, `host.restarted {thread: T}`. Assert i1–i3 remain in order; v1 held state may emit `queue.changed {thread: T, input: i1, op: held}`. GOAT 2 preserves not-yet-started queued inputs; observation of GOAT 2 `queue.changed op: enqueued` is pending; distinguish these from a started run with uncertain delivery, which becomes unknown and blocks pending human choice (`goat2-design/prd-src/part1/runtime.md:100-105`, `goat2-design/prd-src/decisions.md:69`). After actual release, use `queue.changed {thread: T, input: i1, op: released}` and `run.started {thread: T, run: r1, inputs: [i1]}` only if observed.

### `unread_steer_after_restart`

OBSERVED v1 re-dispatches saved unread steer unless an interrupt was requested (`apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:58-106`, `apps/server/src/orchestration-v2/UnreadSteerRecovery.ts:108-155`). With active r1, unread i2, queued i3, and no interrupt, expect `run.started {thread: T, run: r1, inputs: [i1]}`, `input.accepted {thread: T, input: i2, from: user, mode: steer}`, `input.accepted {thread: T, input: i3, from: user, mode: queue}`, `queue.changed {thread: T, input: i3, op: enqueued}`, `host.restarted {thread: T}`, v1 `run.finished {thread: T, run: r1, status: cancelled, cause: server_restart}`, and `queue.changed {thread: T, input: i2, op: enqueued}` at the saved boundary. GOAT 2 recovery of unread steers and observation of `queue.changed op: enqueued` are pending; do not assert `steer.applied` without evidence. Stop variant cancels the unread steer in v1; Stop holds the queue and does not demote interrupt (`goat2-design/prd-src/part1/runtime.md:67-69`).

### `delegated_child_recovery_wakes_parent`

OBSERVED v1 scans terminal child candidates and finalizes under the parent lock (`apps/server/src/orchestration-v2/goat/RecoverTerminalSubagents.ts:6-33`). For a controlled eligible child, expect `child.started {thread: P, child: C}`, `run.started {thread: C, run: r1, inputs: [i1]}`, `host.restarted {thread: C}` and, once supported by actual finalizer evidence, `child.reported {thread: P, child: C, status: cancelled}`. Record `parent.woken {thread: P, child: C, wake: w1, state: queued}` only on evidence of queueing, followed by `parent.woken {thread: P, child: C, wake: w1, state: started, run: r2}` only on observed start. GOAT 2 expects interrupted_by_restart report (`goat2-design/prd-src/part1/runtime.md:103-105`); queued wake evidence remains pending. Finalizer status and branch must be checked per setup, not inferred from the candidate predicate.

### `surviving_codex_turn_then_queue`

OBSERVED v1 survivor harness adopts a live turn without a new native start and delays the queued input (`apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:380-411`, `apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:492-537`). Proposed v1 trace: `run.started {thread: T, run: r1, inputs: [i1]}`, `input.accepted {thread: T, input: i2, from: user, mode: queue}`, `queue.changed {thread: T, input: i2, op: enqueued}`, `host.restarted {thread: T}`, `run.finished {thread: T, run: r1, status: cancelled, cause: server_restart}`, `run.started {thread: T, run: r2, inputs: []}`, `run.finished {thread: T, run: r2, status: done}`, `run.started {thread: T, run: r3, inputs: [i2]}`. Verify continuation input aliases and source cause in the harness before asserting them. Assert survivor adoption has no additional `turn/start`, and a new `turn/start` occurs for the queued input after the survivor completes (`apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts:522-537`). GOAT 2 ends local work, so survivor adoption is not expected (`goat2-design/prd-src/part1/runtime.md:98-109`).

### `resume_completed_provider_thread`

OBSERVED v1 reuses a provider thread after idle restart (`apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts:301-369`). Expected trace: `input.accepted {thread: T, input: i1, from: user, mode: start}`, `run.started {thread: T, run: r1, inputs: [i1]}`, `run.finished {thread: T, run: r1, status: done}`, `host.restarted {thread: T}`, `input.accepted {thread: T, input: i2, from: user, mode: start}`, `run.started {thread: T, run: r2, inputs: [i2]}`, `run.finished {thread: T, run: r2, status: done}`. Assert native thread identity separately. Fixture: `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/codex_transcript.ndjson:1`.

## Open questions

- Which v1 finalizer status and wake path occur for each parent state? Candidate selection alone is insufficient.
- Is there a global v1 runtime generation fence beyond the specific guards in R18?
- Can controlled in-flight crash scenarios reuse an existing Codex transcript without changing expected frames?
