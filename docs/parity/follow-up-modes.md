# Active-run follow-up modes

This is a source-reading specification of v1 admission, provider delivery, queueing, interruption and their observable races. It distinguishes a rejected command from a provider-declined steer after a command was accepted: the pinned implementation has materially different recovery paths. Scenario traces are proposed semantic projections, not claims that a replay or a test was executed.

Pinned v1 commit: `916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4` (read-only export `/tmp/goat-v1-916b5cc`).

## Rules

### R1. Wire and recorded input vocabulary

`message.dispatch` admits `start_immediately`, `steer_active`, `restart_active`, `queue_after_active`, and `defer_start`; optional `deliveryIntent` is `auto`, `steer`, or `restart`. The persisted user-item intents include `turn_start`, `steer`, and `queued_turn`; these are distinct from dispatch modes. **OBSERVED.** Refs: `packages/contracts/src/orchestrationV2.ts:3162-3189`, `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/codex_output.ts:25-41`, `apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/codex_output.ts:20-47`.

### R2. Human composer and start-versus-queue

The web composer defaults its send call to `auto`; explicit queue remains queue. The optimistic message gets `steer` intent when the phase is running, explicit mode is steer, and it is not queued behind setup or compaction. A `start_immediately` request against an active run is queued subject to queue capability; with no active run it starts. **OBSERVED.** Refs: `apps/web/src/components/chat/useComposerSend.ts:305`, `apps/web/src/components/chat/useComposerSend.ts:1223-1238`, `apps/web/src/components/composerTurnPlan.ts:32-50`, `apps/server/src/orchestration-v2/CommandPolicy.ts:621-639`.

### R3. Agent `thread.send` mode translation

Absent mode and `auto` become internal `steer_when_ready`; another thread's agent also gets that behavior for requested `queue` or `steer`. Explicit `restart` is retained, while same-thread and outside callers retain explicit `queue` and `steer`. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ThreadSendMode.ts:4-18`, `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:316-334`, `apps/server/src/mcp/OrchestratorMcpService.ts:3430`.

### R4. Active is wider than steerable

Active includes `preparing`, `starting`, `running`, and `waiting`; the management service's steerable run must itself be `running`, have an active attempt, and have a running provider turn for that attempt. For an untargeted explicit steer with no steerable run and no existing command receipt, the service returns `ThreadManagementNoSteerableRunError` with “Thread <id> has no running turn that can be steered.” **OBSERVED.** Refs: `apps/server/src/orchestration-v2/CommandPolicy.ts:202-208`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:449-461`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1417-1441`, `apps/server/src/orchestration-v2/ThreadManagementErrors.ts:48-57`.

### R5. Automatic resolution and lifecycle gaps

With an active run, explicit delivery intent selects steer or restart; `auto` queues during preparation/start or when its active attempt has no running provider turn. Otherwise `auto` prefers native steer, then queued messages, then interrupt-restart, finally queue; explicit targeting is checked again by policy. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/CommandPolicy.ts:227-267`, `apps/server/src/orchestration-v2/CommandPolicy.ts:557-619`, `apps/server/src/orchestration-v2/CommandPolicy.test.ts:155-156`.

### R6. `steer_when_ready` waits and may promote

A cross-thread sender starts an idle thread, steers a steerable run, queues behind a waiting run, or waits for a starting run. Separate-turn commands and providers supporting neither native steering nor interrupt-restart take the next turn. A steerable run is selected only when provider capabilities are known; promotion is also gated and excludes held or delegated queued runs. The wait is bounded at 45 seconds; after timeout the message is durably queued behind the observed run and a watcher may promote it when the run becomes steerable. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ThreadManagementService.ts:118-122`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1072-1134`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1155-1217`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1222-1280`, `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:713-745`.

### R7. Stop wins the waiting-send race

If Stop reached the observed run while a sender was waiting, the sender gets `ThreadManagementTargetStoppedError`: “The turn on thread <id> was stopped before it could take the message. Send it again to start a new turn.” A `behindRunId` queue dispatch is refused if the run no longer blocks or Stop reached it, so this race cannot silently create a new turn. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ThreadManagementService.ts:1093-1106`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1245-1265`, `apps/server/src/orchestration-v2/ThreadManagementErrors.ts:69-77`, `apps/server/src/orchestration-v2/Orchestrator.ts:5318-5337`, `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:658-705`.

### R8. Separate-turn commands

A no-attachment `/goal` command and native maintenance commands are separate turns: an agent message neither steers such a command into an active turn nor steers into one already active. `/compact` and `/logout` are queued around by the policy; some native goal commands can stop a live run and move to the queue front, while an explicitly queued goal only queues. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/SeparateTurnCommand.ts:4-16`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:1104-1116`, `apps/server/src/orchestration-v2/CommandPolicy.ts:184-190`, `apps/server/src/orchestration-v2/CommandPolicy.test.ts:215-233`, `apps/server/src/orchestration-v2/Orchestrator.ts:5362-5400`.

### R9. Steer execution and Codex request

Native steering is chosen when supported unless a required immediate selection change, incompatible attachments, or explicit restart forces the restart policy. Normally Codex locates the active native turn, waits for steerability, then sends `turn/steer` with `threadId`, `expectedTurnId`, and input; missing active context errors rather than starting a new turn there. During retry backoff, a steer may instead start the retry with that input and return without sending `turn/steer`. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/Orchestrator.ts:4415-4434`, `apps/server/src/orchestration-v2/CommandPolicy.ts:372-391`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:7301-7355`, `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/codex_transcript.ndjson:17-19`.

### R10. Policy refusal is not provider decline

A stale explicit target or absent running provider turn is rejected at admission; the latter reports `No running providerInstanceId turn found for active run <id>.` A running Codex survivor from before server restart refuses steer/restart with “This Codex turn is still running from before the server restarted. Stop it or wait for it to finish before steering.” **OBSERVED.** Refs: `apps/server/src/orchestration-v2/CommandPolicy.ts:23-24`, `apps/server/src/orchestration-v2/CommandPolicy.ts:537-588`, `apps/server/src/orchestration-v2/CommandPolicy.test.ts:362-390`.

A steer that arrives too late is not refused when its target run completed: dispatch turns `steer_active` at a completed run (or at a running run whose provider turn already completed) into `start_immediately`, keeping the submission as a new turn. A steer aimed at a run that ended otherwise (interrupted, failed, cancelled) is refused while dispatching into the run with `OrchestratorDispatchError` “Target run <id> is <status> and cannot be steered.”; nothing is stored or sent. **OBSERVED** (replayed by scenario `steer_refused_at_admission`). Refs: `apps/server/src/orchestration-v2/goat/DispatchModeAdjustment.ts:14-39`, `apps/server/src/orchestration-v2/Orchestrator.ts:5339`, `apps/server/src/orchestration-v2/Orchestrator.ts:4229-4245`.

### R11. Delivery refusal after admission

At delivery, a provider turn that ended produces “The provider turn ended before the steering message was delivered.” A missing live session produces `Provider session <id> is not active.`; Codex wraps a failed `turn/steer` as `ProviderAdapterSteerRunError`, rather than the distinct `ProviderAdapterSteerDeclinedError`. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:157-165`, `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:217-222`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:7323-7355`, `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:558-570`.

### R12. Explicit provider decline queues a follow-up

The pinned v1 Cursor adapter produces the tagged decline (`packages/provider-cursor/src/server/adapter.ts:1720-1741`); the outbox catches the specifically tagged steer-declined error and dispatches the same message as a queued follow-up; the integration test asserts it is not visible as delivered while queued and subsequently starts after the first run ends. This is a documented exception to any blanket claim that every refused steer causes nothing to be sent later. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/EffectWorker.ts:310-360`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:217-263`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:374-407`.

### R13. Missed delivery and retries are separately classified

The effect worker also catches `missedBeforeSubmit` when the turn completed before submission; ordinary messages use `start_immediately`, while delegated completions and notifications queue. Reused message IDs and receipts prevent duplicate follow-ups on retries. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:157-165`, `apps/server/src/orchestration-v2/EffectWorker.ts:310-360`.

### R14. Channel follow-up policy is not a universal bot default

Channel session follow-ups try a steer when `steersInto` permits it, otherwise queue; a definite rejected command may be retried once as queue with new IDs unless permission or dispatch-mode refusal intervenes. Forwarded task follow-ups likewise may retry a definite rejection as queue and, if still refused, tell the sender it did not take the follow-up. **OBSERVED.** Refs: `apps/server/src/channels/ChannelBotSession.ts:669-709`, `apps/server/src/channels/channelForwardFollowUp.ts:220-275`, `apps/server/src/channels/ChannelBotTurns.test.ts:355-386`, `apps/server/src/channels/ChannelBotTurns.test.ts:555-573`.

### R15. Fallback without native steering

A provider that supports interrupt and interrupt-restart can steer through a replacement attempt; one supporting neither is queued by the agent-delivery decision. An unsupported requested policy returns capability errors including `providerInstanceId cannot steer active turns directly or by interrupt-and-restart`. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ThreadManagementService.ts:1123-1133`, `apps/server/src/orchestration-v2/CommandPolicy.ts:372-391`, `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:552-594`.

### R16. Interrupt acknowledgement is not terminal

For restart, v1 requests provider interruption, then waits until both the provider turn and interrupted attempt are no longer running; the wait is bounded at 30 seconds. Timeout reports “Provider terminal state could not be confirmed before restart.”; when no live session exists this particular restart path skips the terminal wait. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:369-385`, `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:388-450`, `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/codex_transcript.ndjson:21-26`.

### R17. Explicit stop and child work

The Stop button's `run.interrupt` sets `holdQueue`; its contract says any interrupt stops wait-mode delegated tasks while async delegated tasks keep running, and Stop also ends PR watches. This is not evidence of blanket v1 demotion of every interrupt to queue whenever a child runs. **OBSERVED.** Refs: `packages/contracts/src/orchestrationV2.ts:3231-3242`, `apps/server/src/orchestration-v2/ChildNeedsStop.ts:5-18`, `apps/server/src/orchestration-v2/ChildNeedsStop.ts:26-50`.

### R18. Replacement as queued first turn

When a provider supports interrupt and queue but not interrupt-restart, an explicit restart of an eligible running turn puts the replacement ahead of ordinary queued runs and requests stop; automatic delegated completions retain delivery priority; this replacement skips an older held queue. If the queued-command interrupt fails, the isolated interrupt events/effects are discarded and the queued command waits for natural completion. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/Orchestrator.ts:5480-5509`, `apps/server/src/orchestration-v2/goat/QueuedCommandInterruption.ts:61-111`, `apps/server/src/orchestration-v2/QueuedRunOrder.ts:12-30`.

### R19. Queue ordering and stop holds

Queued automatic delegated completions have priority, then queue position (or ordinal), then ordinal; held runs are skipped when selecting the next run. A declined steer retains its place relative to earlier and later messages, and a user Stop may hold the recovered follow-up until resume or cancellation. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/QueuedRunOrder.ts:12-30`, `apps/server/src/orchestration-v2/QueuedRunOrder.ts:39-42`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:242-267`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:313-359`.

### R20. Agent input ordering and wake routing

For an agent send with `deliveryIntent: auto` resolved to steer or restart, an unheld queued agent message makes it queue; the integration regression exercises messages queued behind `/compact`. Eligible delegated-completion wakes and notices may steer a running turn only with safe native steering, and that routing never chooses interrupt-restart. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/goat/AgentQueueOrder.ts:5-16`, `apps/server/src/orchestration-v2/AgentQueueOrder.integration.test.ts:14-15`, `apps/server/src/orchestration-v2/AgentQueueOrder.integration.test.ts:102-115`, `apps/server/src/orchestration-v2/Orchestrator.ts:5511-5572`, `apps/server/src/orchestration-v2/goat/DispatchModeAdjustment.ts:44-59`.

### R21. Visible refusal and retained queue item

The queue control displays the error from a refused `Steer` or `Send now` action; a mocked interrupted command leaves the queued message available in the UI; this does not establish persisted server retention. This UI result is an admission/action refusal and does not by itself establish what happens to a provider-declined outbox effect. **OBSERVED.** Refs: `apps/web/src/components/chat/QueuedRunsControl.tsx:227-250`, `apps/web/src/components/chat/QueuedRunsControl.browser.test.tsx:226-278`.

## Capability flags

- `supportsActiveSteering` selects native steering; `supportsInterrupt` and `supportsSteeringByInterruptRestart` jointly permit the replacement policy. **OBSERVED.** Refs: `packages/contracts/src/providerCapabilityParts.ts:108-119`, `apps/server/src/orchestration-v2/CommandPolicy.ts:372-391`.
- `supportsQueuedMessages` gates app-owned queued turns; the policy error is `providerInstanceId does not support app-owned queued turns`. **OBSERVED.** Refs: `packages/contracts/src/providerCapabilityParts.ts:118-119`, `apps/server/src/orchestration-v2/CommandPolicy.ts:361-370`.
- `activeSteeringAcceptsAttachments=false` can force restart; `activeSteeringInterruptsTools=true` excludes the safe wake-steering path. `activeSteeringDuringCompaction` describes automatic compaction, distinct from a native maintenance-command turn. **OBSERVED.** Refs: `packages/contracts/src/providerCapabilityParts.ts:111-117`, `apps/server/src/orchestration-v2/Orchestrator.ts:4415-4431`, `apps/server/src/orchestration-v2/Orchestrator.ts:5562-5572`.
- Codex advertises `supportsInterrupt`, `supportsNativeResume`, `supportsActiveSteering`, `activeSteeringDuringCompaction`, `supportsSteeringByInterruptRestart`, and `supportsQueuedMessages` true; terminal quality is `strong`. The attachment and tool-interruption optional fields are not specified in this object. **OBSERVED.** Ref: `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:22-32`.

## Existing v1 tests and fixtures

- `SteeringHarness.ts` provides a controllable fake adapter, records starts/steers/interrupts, and can inject a steer error; it is not itself a recorded Codex transcript. **OBSERVED.** Ref: `apps/server/src/orchestration-v2/testkit/SteeringHarness.ts:38-67`, `apps/server/src/orchestration-v2/testkit/SteeringHarness.ts:135-160`.
- `OrchestratorScenario.ts` supports command dispatch, awaiting a steerable run or status, and replay gates. **OBSERVED.** Ref: `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts:31-93`.
- `message_steering` supplies message then steer input and a Codex transcript with one `turn/steer`; output asserts one run and no extra provider turn. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/input.ts:7-17`, `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/codex_transcript.ndjson:17-19`, `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/codex_output.ts:25-41`.
- `queued_turn` has a Codex transcript and queues a second message; its output asserts `queued_turn` input intent and queued state. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/input.ts:7-13`, `apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/codex_output.ts:20-47`.
- `turn_interrupt` has a Codex transcript in which interrupt acknowledgement precedes interrupted terminal; `turn_interrupt_mid_tool` has a separate Codex transcript and waits for command execution before interrupting. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/codex_transcript.ndjson:21-26`, `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/input.ts:3-9`, `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/codex_output.ts:55-85`.
- `SteeringDeclined.integration.test.ts` tests tagged decline, hold and order; `SteeringDelegatedDecline.integration.test.ts` tests a declined delegated completion wake becoming queued. These use the harness, not those Codex replay transcripts. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:94-111`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:217-263`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:313-359`, `apps/server/src/orchestration-v2/SteeringDelegatedDecline.integration.test.ts:25-44`, `apps/server/src/orchestration-v2/SteeringDelegatedDecline.integration.test.ts:107-132`.
- `AgentThreadSteering.integration.test.ts` exercises cross-thread modes, restart fallback, stop races and delayed promotion; `AgentQueueOrder.integration.test.ts` pins ordering behind maintenance. **OBSERVED.** Refs: `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:316-334`, `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:552-594`, `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:658-745`, `apps/server/src/orchestration-v2/AgentQueueOrder.integration.test.ts:14-15`.

## GOAT 2 mapping

**OBSERVED** v1 rules are cited above; **INFERRED** scenario projections below are planned expectations, not executed GOAT 2 evidence. Part 1 targets 15 log events: 14 contract variants plus owner-approved `input.changed` (lane C pending). Decision: `goat2-design/prd-src/decisions.md:69-73`, `goat2/crates/goat2-contracts/src/log.rs:1-260`.

| v1 rule | v1 observable | Part 1 status (same / deliberate difference / deferred / pending) | GOAT 2 evidence (log event or command/MCP reply) | coverage (scenario name or "source-only") |
|---|---|---|---|---|
| R1–R6 | admission, queue and steer selection | same | `input.accepted`, `run.started`, `input.delivered` | codex_live_steer, queued_followups_in_order |
| R7, R10, R21 | admission or promotion refused, nothing sent | same | command/MCP error reply; an already queued input remains where applicable | stop_wins_waiting_send |
| R8, R18–R20 | ordering, replacement and wake routing | pending | `input.accepted`, `input.changed`, `run.started`, `child.reported` | queued_followups_in_order, delegated_wake_declined |
| R9, R15–R16 | steer and terminal observation | same | `input.delivered`, `run.finished` | codex_live_steer, interrupt_ack_before_terminal |
| R11–R13 | tagged decline queues same id; missed ordinary steer starts same id immediately | same | same-ID redispatch; GOAT 2 enqueue observation pending | provider_decline_followup; source-only |
| R11 Codex RPC error | wrapped error is not re-queued | pending | command/error or subsequent log outcome pending replay | source-only |
| R14 | channel definite-rejection retry | pending | command reply and subsequent admission | source-only |
| R17 | Stop holds queue, stops wait-mode children; async children continue | same | command reply, `run.finished`, `child.reported` | source-only |

Admission refusal fails closed with nothing sent. A Codex start that finds a native turn GOAT never owned behaves in three ways: when the start may steer, GOAT steers the message into that turn and the run adopts it (`apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:113-116`, `apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:150-172`, `apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:186-190`); when it may not steer, the start is refused; at dispatch, a turn that is not unowned is refused, while during preparation a previously stopped turn can first receive another interrupt (`apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:110-128`, `apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:150-190`); when Codex refuses that `turn/steer`, the start fails with "refused this message, so it was not sent", and when Codex does not confirm, it fails with "did not confirm whether the turn it is running took this message, so GOAT did not send it again" (`apps/server/src/orchestration-v2/Adapters/CodexTurnStartGuard.ts:171-183`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.startGuard.test.ts:323-345`). Neither failure resends. After admission tagged declines and delegated completions/notifications re-dispatch the same message ID with `queue_after_active`; ordinary `missedBeforeSubmit` uses `start_immediately`, without an enqueue transition. There is no interrupt demotion. **OBSERVED** v1; **INFERRED** Part 1 target. `apps/server/src/orchestration-v2/EffectWorker.ts:310-360`, `apps/server/src/orchestration-v2/ChildNeedsStop.ts:5-50`, `goat2-design/prd-src/decisions.md:69`.

Codex wraps turn/steer RPC errors in `ProviderAdapterSteerRunError`, not the tagged decline. The control service tags only `ProviderAdapterSteerDeclinedError`, so EffectWorker does not re-queue that RPC error. **OBSERVED:** `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:7323-7355`, `apps/server/src/orchestration-v2/ProviderTurnControlService.ts:558-570`, `apps/server/src/orchestration-v2/EffectWorker.ts:310-318`. Final v1 outcome **pending replay `steer_rpc_error_codex`**; no runtime outcome is inferred.

## Parity scenarios

The following traces are **INFERRED** planned projections of the cited v1 source, not executed replays. Traces show only relevant transitions, in order, and omit independent internal events. `T` is the receiving thread; `A` is an agent caller. `queue.changed` and `steer.applied` are semantic trace kinds, not additional asserted Part 1 log events.

### `codex_live_steer`

- Setup: idle T, Codex native steering enabled.
- Steps: user submits first message; await running provider turn; submit explicit steer.
- Trace:
  1. `input.accepted {thread:T, input:i1, from:user, mode:start}`
  2. `run.started {thread:T, run:r1, inputs:[i1]}`
  3. `input.accepted {thread:T, input:i2, from:user, mode:steer}`
  4. `steer.applied {thread:T, run:r1, input:i2}`
  5. `run.finished {thread:T, run:r1, status:done}`
- Driver: OrchestratorScenario command dispatch and await steerable; reuse `message_steering/codex_transcript.ndjson`. Ref: `apps/server/src/orchestration-v2/testkit/fixtures/message_steering/codex_output.ts:25-41`.

### `queued_followups_in_order`

- Setup: T has a running turn; queue is unheld, with no automatic completion priority.
- Steps: user queues B, then C; finish active turn and each subsequent run.
- Trace:
  1. `input.accepted {thread:T, input:B, from:user, mode:queue, text:"B"}`
  2. `queue.changed {thread:T, input:B, op:enqueued}`
  3. `input.accepted {thread:T, input:C, from:user, mode:queue, text:"C"}`
  4. `queue.changed {thread:T, input:C, op:enqueued}`
  5. `run.finished {thread:T, run:r1, status:done}`
  6. `run.started {thread:T, run:r2, inputs:[B]}`
  7. `run.finished {thread:T, run:r2, status:done}`
  8. `run.started {thread:T, run:r3, inputs:[C]}`
- Driver: command dispatch via OrchestratorScenario or SteeringHarness. `queued_turn/codex_transcript.ndjson` covers one queued follow-up; extend replay for C. Refs: `apps/server/src/orchestration-v2/testkit/fixtures/queued_turn/input.ts:7-13`, `apps/server/src/orchestration-v2/QueuedRunOrder.ts:20-30`.

### `stop_wins_waiting_send`

- Setup: T has a starting provider run; A's `thread.send` waits for steerability.
- Steps: explicitly stop the observed run before it becomes steerable; allow the waiting call to resolve.
- Trace:
  1. `run.started {thread:T, run:r1, inputs:[i1]}`
  2. Stop reaches the observed run before the send is refused.
  3. `input.refused {thread:T, input:i2, code:target_stopped}` and `tool.result {thread:A, call:c1, path:thread.send, status:error, code:target_stopped}`.
  4. `run.finished {thread:T, run:r1, status:interrupted}` after terminal observation; terminal observation and error resolution are independently awaited, with no asserted ordering between them.
- No accepted input or new run for that send. Driver: `ThreadManagementService` harness / MCP handler with a controlled start; `turn_interrupt/codex_transcript.ndjson` supplies interrupt frames but requires a new combined fixture for the waiting sender. Refs: `apps/server/src/orchestration-v2/AgentThreadSteering.integration.test.ts:658-705`, `apps/server/src/orchestration-v2/ThreadManagementErrors.ts:69-77`.

### `provider_decline_followup`

- Setup: active T; fake adapter returns tagged `ProviderAdapterSteerDeclinedError` after admission.
- Steps: user sends explicit steer; drain outbox; end the active run and resume queue.
- v1 trace:
  1. `input.accepted {thread:T, input:i2, from:user, mode:steer}`
  2. `queue.changed {thread:T, input:i2, op:enqueued}`
  3. `run.finished {thread:T, run:r1, status:done}`
  4. `run.started {thread:T, run:r2, inputs:[i2]}`
- GOAT 2 target: same ID and `queue_after_active` after tagged decline; Cursor is the v1 tagged-decline producer, while Codex missed-before-submit ordinary messages use `start_immediately`. **INFERRED** target; `packages/provider-cursor/src/server/adapter.ts:1720-1741`, `apps/server/src/orchestration-v2/EffectWorker.ts:310-360`, `goat2-design/prd-src/decisions.md:69`. Driver: SteeringHarness and fake decline; no existing Codex transcript covers tagged decline. Ref: `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:217-263`, `apps/server/src/orchestration-v2/SteeringDeclined.integration.test.ts:385-407`.

### `interrupt_ack_before_terminal`

- Setup: T running a Codex turn with an active tool.
- Steps: user requests Stop; observe RPC acknowledgement, then replay terminal event.
- Trace:
  1. `run.started {thread:T, run:r1, inputs:[i1]}`
  2. `run.finished {thread:T, run:r1, status:interrupted}` only after terminal
- After acknowledgement and before releasing the terminal frame, explicitly assert that no `run.finished` is observed; inspect provider frames in the harness. Driver: OrchestratorScenario; reuse `turn_interrupt_mid_tool/codex_transcript.ndjson`. Refs: `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/input.ts:3-9`, `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/codex_transcript.ndjson:30-35`.

### `delegated_wake_declined`

- Setup: T has a running parent; child C reports a completion eligible for a native-steer wake; fake provider declines it.
- Steps: dispatch completion as a server-owned message, drain effect, then finish the active run.
- Trace (v1 target; the GOAT 2 target asserts only items 1, 2, 5, 6 and 7, since the enqueue and a queued wake have no GOAT 2 evidence yet):
  1. `child.reported {thread:T, child:C, status:done}`
  2. `input.accepted {thread:T, input:i2, from:child, mode:queue_after_active}` followed by native-steer delivery
  3. `queue.changed {thread:T, input:i2, op:enqueued}`
  4. `parent.woken {thread:T, child:C, wake:w1, state:queued, run:r2}`
  5. Parent run `r1` enters `waiting`.
  6. `run.started {thread:T, run:r2, inputs:[i2]}`
  7. `parent.woken {thread:T, child:C, wake:w1, state:started, run:r2}`
- Driver: SteeringHarness plus delegated completion setup; no existing Codex transcript covers this decline. The same wake input ID is re-dispatched with `queue_after_active`; GOAT 2 queued-wake observation is pending, and only evidenced started/steered transitions may be asserted. **INFERRED** target; `apps/server/src/orchestration-v2/EffectWorker.ts:324-358`, `goat2-design/prd-src/decisions.md:69`. Ref: `apps/server/src/orchestration-v2/SteeringDelegatedDecline.integration.test.ts:107-132`, `apps/server/src/orchestration-v2/SteeringDelegatedDecline.integration.test.ts:146-165`.

## Open questions

2. How are held state and refused submissions represented beyond the command error reply? Queue mutations use `input.changed`; agent origin is represented by the semantic trace origin. `goat2-design/prd-src/decisions.md:73`.
3. What is the precise observable for a held queue transition? The restart acceptance boundary is `run.accepted`; the 15-event target includes `input.changed`. `goat2-design/prd-src/part1/runtime.md:94-109`, `goat2-design/prd-src/decisions.md:73`.
4. Which UI flows or bot thread classes, beyond the inspected composer and channel follow-up handlers, use separate defaults? Do not infer a universal v1 bot `followup` default from Part 1.

NOT RUN: tests, servers, installs, paid-model calls, or live provider reproduction. All outcomes above are source and fixture observations.
