# 000 — Question escalation to the launching orchestrator (#13)

Refs goat-si/goat#13. Related: #5 (remote reverse report), #10 (delegate to SSH hosts), #12 (loops as top-level threads), #7/#8 (host routing correctness).

## Loop spec

- Class: C4 (public MCP contract, persisted thread/request schema, cross-thread delivery, authority boundary).
- Mode: cxc-loop HOTL owned by the main thread. Research, doc drafting and implementation slices go to `delegate_task` children on `codex/gpt-6.1-sol`; reviews of GPT-built code go to an Anthropic-family reviewer.
- Branch/worktree: `goat/question-escalation` at `/Users/jun/.goat/worktrees/goat/goat-question-escalation`, base `origin/dev` (`070941cae` at P).
- Write scope: `packages/contracts`, `packages/provider-core/src/server/{orchestrationInstructions,subagentProjection}.ts`, `packages/client-runtime` (answer history), `packages/shared` (MCP tool presentation), `apps/server` (MCP toolkits/services, orchestration-v2, sshRemote), `apps/web` + `apps/mobile` answer-history rendering, `docs/internals` only where a cross-component constraint changes, this devlog unit.
- Out of scope: writes to goat_initiative, merging to dev, PRs, issue comments/closing, restarting the live GOAT servers (3773/3774), other worktrees, repo-wide checks, the general #5 reverse-report channel.
- Resource bounds: none stated; host limits apply.
- Publication: push `goat/question-escalation` only, after lint/typecheck/focused tests pass on a fresh rebase onto `origin/dev`. Commit messages carry `Refs #13`.

## Problem

An orchestrator dispatches work (`goat_thread_launch`, `create_threads`, `goat_ssh_thread_launch`, `delegate_task`). When the dispatched thread asks the user a question it blocks in its own thread. The launcher is never told, cannot read the question on another host, and the asking agent sometimes sleep-polls. Evidence: [001_research.md](001_research.md).

## Decisions

Architect proposal (gpt-6.1-sol, task `q13-wp0-architect-proposal`) D1–D9; main disposition in brackets.

- **D1 Launcher identity [ACCEPT, amended].** New optional `OrchestrationV2AppThread.launcher` and matching `thread.create` field:
  `{ threadId: ThreadId, environmentId: EnvironmentId | null, via: "thread_launch" | "create_threads" | "ssh_thread_launch" | "delegate_task" }`.
  `environmentId: null` means the launcher lives in this environment. Set from the authenticated MCP caller (never from model-supplied arguments) on `goat_thread_launch`, `create_threads` and app-owned `delegate_task` children (`makeSubagentChildThread` call in `Orchestrator.ts` delegated-task path only; provider-native subagents stay without a launcher). For SSH launches the origin passes `launcher: { threadId, environmentId: <origin env id> }` to the remote `goat_thread_launch`; the remote accepts that argument only from an outside MCP client (a caller with no thread) and records `via: "ssh_thread_launch"`. Lineage is unchanged and keeps meaning ancestry. Legacy delegated children without `launcher` fall back to app-owned subagent lineage. Thread JSON is persisted whole (`ProjectionStore.ts` thread payload), so no migration; shell builders copy the field.
- **D2 Typed question event [ACCEPT, amended].** New notification source member `{ kind: "question", threadId, requestId, humanRequired: boolean }` in `OrchestrationV2NotificationSource` (falls back to `background_task` on old clients via `kindUnionWithFallback`). The launcher receives a `message.dispatch` carrying that notification and a model-facing text with prose plus one fenced `goat-question` JSON block: `{ threadId, title, requestId, questions:[{id, header, question, options:[{label, description}], multiSelect}], deadline: null, humanRequired, answerWith }`. `deadline` is always `null`: runtime requests have no deadline today and none is invented. Provider adapters are not changed: the message text is what every provider already receives.
- **D3 Recoverable server service [ACCEPT].** New `apps/server/src/orchestration-v2/QuestionEscalationService.ts` (scoped layer, forked at activation like `PullRequestWatchReactor`). It subscribes to stored `runtime-request.updated` and `turn-item.updated` events, reads committed state, and when a pending `user_input` request has its `user_input_request` item and a same-environment launcher, dispatches `message.dispatch` to the launcher with the deterministic `commandId` `question-escalation:<askingThreadId>:<requestId>` and `messageId` of the same shape. The command receipt store makes re-dispatch idempotent. On start it subscribes first, then sweeps pending `user_input` requests in threads that have a launcher (bounded query) and re-dispatches. Delivery mode: `queue_after_active` like PR-watch wakes.
- **D4 Provenance [ACCEPT, simplified].** `respondedBy` on `runtime-request.respond`, on the resolved `OrchestrationV2RuntimeRequest`, and on `UserInputAttachmentAnswerPayload` (`questionAnswer`):
  `{ type: "user" } | { type: "agent", threadId: ThreadId, environmentId: EnvironmentId | null, title: string | null, reason: string }`.
  WS client commands are stamped `{ type: "user" }` in `ws.ts` (any client-supplied value is overwritten). MCP respond stamps the authenticated caller and requires `reason` (1–2000 chars). Message-mode answers from an agent are dispatched `createdBy: "agent"`, `senderThreadId`, and the text starts with `Answered by orchestrator "<title>" (<threadId>): <reason>`. Live-mode answers keep answer values byte-for-byte (option labels must match). Old records without `respondedBy` display no responder. The "relayed human answer" flag is dropped: a relay is recorded truthfully as an agent answer whose reason says it relays the user.
- **D5 First answer wins, both sides told [ACCEPT, narrowed].** Arbitration stays in the asking thread's dispatch lock. `dispatchRuntimeRequestRespond` rejects a non-pending request with `This question was already answered by <responder> at <time>.` and MCP maps it to `invalid_request` with that text; `goat_pending_request_read` returns resolved requests too (`status`, `respondedBy`, `resolvedAt`) so a stale notification stays actionable. When a request the service escalated leaves `pending` for any reason (answered by anyone including the launcher, dismissed, settled, expired): if the escalation message's run is still queued in the launcher, the service cancels exactly that queued run (`queued-run.cancel`); if it was already delivered and the responder is not the launcher, it queues one short resolution notice (`question-resolution:<thread>:<request>`, notification source `question`, outcome `completed`). Dismissals are stamped `user` and read "dismissed". No other launcher run is touched. (Amended after audit q13-wp0-audit-r1b M2/M3.)
- **D6 Human authority [ACCEPT].** Only `user_input` requests are escalated or answerable by agents; approvals (`command`, `file-read`, `file-change`, `mcp-elicitation`, `permission`) stay human-only and are never escalated. Agent answers still pass the existing target ceiling (`writesThreads` + `DispatchModeLimit`, re-checked under lock). The escalation marks `humanRequired: true` when the asking thread's runtime or interaction mode is above the launcher's, and the text tells the launcher to forward to the human; MCP respond in that case fails with the existing ceiling code and a message that says to forward to the human. Launcher relationship selects delivery only; it grants no authority.
- **D7 Waits release on questions [ACCEPT].** `goat_thread_wait` returns early with `timedOut: false` and a new `pendingRequestIds` when the waited run has a pending `user_input` request (also at entry). `delegate_task(mode:"wait")` returns early the same way with `pendingRequestIds` and upgrades the task's completion wake to `always`, mirroring the existing wait-timeout path. Provider-native blocking questions (Codex `request_user_input`, Claude `AskUserQuestion`, ACP) already park on a Deferred and resume on answer; the orchestration instructions say: after an async question tool, end the turn, the answer arrives as a message; never sleep-poll.
- **D8 Host-aware pending tools [ACCEPT, narrowed].** New `apps/server/src/mcp/PendingQuestionsMcpService.ts` owns list/read/respond (moved out of the thread toolkit handlers) and routes `host` through `SshRemoteDispatch.callHostTool` exactly like `HostThreadsMcpService` (remote reads `writes:false`, respond `writes:true`; remote targets require `threadId`). `goat_pending_request_list` keeps `{requestIds}` for single-thread use and adds `scope: "launched"` returning `questions: [{host, threadId, title, requestId, questions, humanRequired}]` for threads whose `launcher.threadId` is the caller (local query), plus every connected host and any explicit `hosts[]` (fan-out with `unavailableHosts`). Persisted remote dispatch links are deferred: after an origin restart, `connectedHosts` is empty until the launcher touches a host, so the launcher passes `hosts`. Recorded as residual risk.
- **D9 Remote-to-origin delivery [REJECTED for this unit; seam documented].** The user directed: finish the same-environment path and host arguments, document the interface for #5. Automatic delivery of a remote thread's question to its origin is #5's reverse channel. This unit supplies its inputs (remote `launcher` record, typed question event, `goat_thread_wait({host})` release, `scope:"launched"` remote filter) and specifies the seam in [040_wp4_hardening_seam_publish.md](040_wp4_hardening_seam_publish.md).

## Main dispositions of drafting-lane amendments (wp0)

- **010-A1 [ACCEPT]** Write scope adds `packages/provider-core/src/server/subagentProjection.ts` (+ its focused test): `makeSubagentChildThread` clears an inherited `launcher`; the app-owned `delegate_task` call in `Orchestrator.ts` stamps its own. Without it provider-native children of a launched thread would inherit the launcher.
- **010-A2 + 030-A1 [AMEND D4]** `respondedBy` gains a third variant and the agent variant may be foreign:
  `{ type: "user" } | { type: "agent", threadId, environmentId: EnvironmentId | null, title: string | null, reason } | { type: "client", reason }`.
  A local thread caller is stamped `agent` with `environmentId: null`. A threadless outside MCP client is stamped `client` (existing outside respond keeps working; nothing is fabricated). In wp3 the origin of a host-routed respond sends its authenticated caller as a reserved `respondedBy` argument; the destination accepts it only from an outside client and only as `agent` with a non-null foreign `environmentId`, and rejects it from thread callers. It is recorded as claimed by that authenticated client session, the same trust level as the SSH `launcher` pass-through (D1). Display: `client` → "Answered by an MCP client: <reason>"; foreign agent → "Answered by orchestrator <title> on another machine: <reason>".
- **010-OQ1 [ACCEPT]** Forks do not inherit `launcher` (omit the field in `ThreadForkService`; with `exactOptionalPropertyTypes` destructure it out rather than assigning `undefined`).
- **010-OQ2, OQ4, OQ5 [ACCEPT defaults].**
- **010-OQ3 [DECIDE]** `reason` must contain a non-whitespace character (1–2000 chars after the check; stored unchanged). Answers are never trimmed.
- **020-A1 [ACCEPT default]** A durably rejected escalation command is terminal for that delivery and logged; transport/storage failures retry with the same id.
- **020-A2 [ACCEPT limitation]** Resolutions that happen while the service is down are not reconciled at restart. Impact is bounded: the launcher may see an already answered question, and `goat_pending_request_read`/respond tell it who answered (D5). Recorded as residual risk.
- **020-Q1..Q6 [ACCEPT defaults]** (settled launchers are still woken like any `message.dispatch`).
- **030 open questions [ACCEPT defaults]** unless the reflection or audit finds a conflict.

## Work-phase map (dependency order)

| WP  | Doc                                                                    | Layer       | Delivers                                                                                                                                                               | Independently verifiable by                                                      |
| --- | ---------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| wp0 | this unit 000/001/010–040                                              | roadmap     | decisions + diff-level docs                                                                                                                                            | A review, docs only                                                              |
| wp1 | [010_wp1_foundations.md](010_wp1_foundations.md)                       | foundations | contracts (launcher, provenance, notification source, already-answered), launcher recording on local launch paths, provenance capture (WS/MCP), answer-history display | contract + Orchestrator scenario + MCP toolkit tests                             |
| wp2 | [020_wp2_escalation_service.md](020_wp2_escalation_service.md)         | core        | QuestionEscalationService: delivery, humanRequired, resolution notice/dispose, startup recovery                                                                        | scenario tests draining the effect worker                                        |
| wp3 | [030_wp3_host_tools_waits.md](030_wp3_host_tools_waits.md)             | integration | host-aware pending tools, scope launched, SSH launcher pass-through, wait releases, instructions                                                                       | HostThreadsMcpService-style tests, ThreadManagementService/OrchestratorMcp tests |
| wp4 | [040_wp4_hardening_seam_publish.md](040_wp4_hardening_seam_publish.md) | hardening   | #5 seam doc, internals doc touch, branch review, rebase, verify, push                                                                                                  | final gate + push                                                                |

## Acceptance criteria (goalplan c-1..c-5)

1. c-1 Launcher recorded on goat_thread_launch, create_threads, delegate_task children; question in such a thread produces exactly one launcher message with notification source `question` and the JSON block (activation: scenario test awaits the service subscription-readiness signal, raises a Codex-shaped user_input request in a launched thread, then awaits the persisted launcher message with the deterministic id).
2. c-2 MCP respond from the launcher resolves with `respondedBy.type = "agent"` + reason; WS respond stamps `user`; second responder gets "already answered by …"; approval requests are rejected and never escalated; above-ceiling answer refused with forward-to-human text.
3. c-3 `host` on list/read/respond routes via callHostTool (tests mirror HostThreadsMcpService.test.ts); `scope:"launched"` lists local + remote with `unavailableHosts`.
4. c-4 `goat_thread_wait` and `delegate_task(mode:"wait")` return on a pending question; instructions forbid sleep-polling; #5 seam documented.
5. c-5 Targeted lint, typecheck for touched packages, focused tests pass; cross-family review has no open blocker; rebased on origin/dev; pushed with Refs #13.

## Verifiers (run during P, PLAN-VERIFIER-REAL-01)

Recorded in [001_research.md](001_research.md#verifiers) with exit codes.

## Architect consultation

- Proposal: task `q13-wp0-architect-proposal` (gpt-6.1-sol) — dispositions above.
- Reflection: task `q13-wp0-architect-reflection` — MISALIGNED with 6 gaps (client provenance chain, reason check, forward-to-human text, #5 seam schema/replay, c-1 race) and 2 undisclosed D8/D9 risks. All folded as binding errata at the top of 010/020/030 and in 040 §1; D8/D9 risks disclosed in 030 errata. A audit q13-wp0-audit-r1b (anthropic/claude-opus-5-5): NEAR-PASS, 0 blockers, 3 majors (message-mode waits, launcher self-answer queued run, dismiss/settle attribution) + 8 minors, all folded as errata (010 E6-E11, 020 E4-E6, 030 E6-E7, D5 amended); minors 4 and 8 recorded as residual risks below.

## SoT sync target

`docs/internals/`: add or amend the paragraph that owns cross-thread delivery (question escalation is a cross-component constraint: launcher identity is separate from lineage; agent answers never carry approval authority). Check `docs/user/` for the pending-question section.

## Residual risks (recorded at wp0)

- SSH-transported `launcher` and `respondedBy` are claims made by an authenticated outside MCP client session, not cryptographic proof of the origin thread; the UI line "on another machine" reflects that claim. To be stated in the wp4 internals paragraph.
- A delegated child's run that continues after an async (message-mode) answer is not reported back through `recordSubagentFollowup` (pre-existing; `Orchestrator.ts` ~10505). The launcher sees the child's later state through `task_status`/waits.
- Resolutions during service downtime are not reconciled at restart (020-A2).
- After an origin restart, `scope:"launched"` covers remote hosts only when connected or passed in `hosts` (D8).
- Remote-to-origin automatic delivery waits on #5 (D9; seam in 040 §1).
