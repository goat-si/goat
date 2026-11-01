# 001 — Research record (#13)

Read-only research lanes on `codex/gpt-6.1-sol` at base `070941cae`. Paths are relative to the worktree root. Main spot-checked the anchors marked ✓.

## R1 Pending request model (task q13-wp0-r1-pending)

All paths below are relative to `/Users/jun/.goat/worktrees/goat/goat-question-escalation`. Findings are from current source; no files were changed.

**1. Provider question → pending request**

V2 uses **`runtime_request.updated` → `runtime-request.updated`**, with `status: "pending"` then `"resolved"`. `ProviderEventIngestor.ts:606–623` converts adapter events into domain events; `ProjectionStore.ts:2319–2354` upserts `orchestration_v2_projection_runtime_requests`, including its JSON payload.

Contracts:

- `packages/contracts/src/orchestrationV2.ts:1029–1047`: `OrchestrationV2RuntimeRequest` contains IDs, native reference, `kind`, status, response capability, timestamps, optional `decision` and `answers`.
- `packages/contracts/src/orchestrationV2.ts:1424–1430`: `user_input_request` turn item contains `requestId`, structured `questions`, optional `questionAnswer` and message response mode.
- `packages/contracts/src/orchestrationV2.ts:1740–1741`: domain event `"runtime-request.updated"`.
- The separate provider-runtime contract defines `"user-input.requested"` / `"user-input.resolved"` and their payloads at `packages/contracts/src/providerRuntime.ts:178–179,502–511,983–997`. Those are **not the event names used by the traced V2 adapter pipeline**.

Adapter mappings:

| Provider          | Mapping and anchor                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex             | `"item/tool/requestUserInput"` creates node, runtime request and turn item, then emits their updates: `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:5437–5478`. Request is `kind: "user_input"` with live capability: same file `4173–4199`. Async agent-message questions instead use `"message"` capability: `4960–4987`.                                                                                 |
| Claude            | `AskUserQuestion` creates `requestKind: "user_input"`, an answers `Deferred`, and the same three updates: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7041–7078`. Other approval requests use a decision `Deferred`: `7151–7177`.                                                                                                                                                                        |
| ACP / Antigravity | ACP permission requests are questions only when `extractPermissionQuestion` recognizes them; otherwise they follow permission handling: `packages/provider-acp/src/server/adapter.ts:5658–5671`. Antigravity supplies that extractor: `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts:205–216`; its protocol recognizes `"interaction_"` IDs: `apps/server/src/provider/acp/AntigravityProtocol.ts:46`. |
| Grok              | `"x.ai/ask_user_question"` and `"_x.ai/ask_user_question"` call ACP `requestUserInput`: `packages/provider-grok/src/server/adapter.ts:182–209`.                                                                                                                                                                                                                                                                            |
| OpenCode          | `"question.asked"` versus `"permission.asked"` routes to question versus permission requests: `packages/provider-opencode/src/server/adapter.ts:2593–2608`; questions become `"user_input"`: `1846–1877`. V2 OpenCode uses `"form.created"` versus `"permission.asked"`: `packages/provider-opencode/src/server/v2/adapter.ts:2553–2557`; supported forms become `user_input_request`: `2094–2103`.                        |
| Pi                | Extension `select/input/editor` versus `confirm`: `packages/provider-pi/src/server/adapter.ts:1243–1246,1281–1286`, specifically `kind: method === "confirm" ? "command" : "user_input"`.                                                                                                                                                                                                                                  |
| Muse              | Native user input versus approval subject determines `"user_input"` or command/file/permission kind: `packages/provider-muse/src/server/adapter.ts:847–855`; native methods include `"userInput/request"` / `"approval/request"`: `1426–1428`.                                                                                                                                                                             |
| Cursor            | Interactive response is unsupported: `"Cursor Agent SDK does not expose interactive approval requests."` `packages/provider-cursor/src/server/adapter.ts:2492–2501`. **INFERENCE:** no pending-question response support in this adapter.                                                                                                                                                                                  |

Several implementations moved into provider packages; built-in driver imports show this at `apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts:3–21`.

Approval kinds are `"command"`, `"file-read"`, `"file-change"`, `"mcp-elicitation"`, `"permission"`; decisions are accept variants, decline or cancel: `packages/contracts/src/providerPolicy.ts:38–55`. Codex MCP elicitation notably creates an **approval**, `requestKind: "mcp-elicitation"`: `CodexAdapterV2.ts:5265–5275`.

**2. Answering today; authorization**

Web calls shared `respondToThreadApproval` or `respondToThreadUserInput`, both dispatching `"runtime-request.respond"`; approvals send `decision`, questions send `answers` and optional attachments: `packages/client-runtime/src/operations/commands.ts:834–857`. Dispatch uses `"orchestration.dispatchCommand"`: same file `269–270`; `packages/contracts/src/orchestrationV2.ts:3146`. Server authorization requires `"orchestration:operate"`: `apps/server/src/auth/RpcAuthorization.ts:43–45`.

MCP:

- List returns only pending `"user_input"` request IDs: `apps/server/src/mcp/toolkits/thread/handlers.ts:203–210`.
- Read returns `{requestId, questions}`: same file `213–216`.
- Respond takes **`threadId?`, `requestId`, `answers`**: `apps/server/src/mcp/toolkits/thread/tools.ts:130,169–173`. Answers are `Record<string, unknown>`: `packages/contracts/src/providerPolicy.ts:67`.
- Respond dispatches the existing command and returns `{sequence}`: `handlers.ts:219–231`.
- **Cannot answer approvals:** `readQuestion` requires `"user_input"` and `"pending"`: `handlers.ts:52–69`; description explicitly says `"This cannot approve a permission request"`: `tools.ts:172`.

Checks:

- Orchestration capability is required by `readThread → readCaller`: `apps/server/src/mcp/threadAccess.ts:55–63,172–176`.
- Writes reject read-only MCP clients and require a live caller: `apps/server/src/mcp/McpToolAccess.ts:100–128`.
- Live thread means unarchived, active run, matching provider instance: `threadAccess.ts:121–132`.
- Caller ceilings come from its current thread modes or the outside MCP client ceiling: `threadAccess.ts:70–98`.
- Cross-thread writes check target modes and inject `DispatchModeLimit`: `McpToolAccess.ts:182–211`; orchestrator rechecks under lock: `Orchestrator.ts:10722–10732`.
- Runtime order is approval-required < auto-accept-edits < auto < full-access; interaction order plan < default: `OrchestratorMcpService.ts:535–549`.

**Trap:** respond does not require full-access/default; it checks relative ceilings. Above-ceiling calls are refused, not automatically delivered to a human: `threadAccess.ts:105–113`; `McpToolAccess.ts:215–222`.

**3. Two responders / first answer wins**

`dispatchRuntimeRequestRespond` rejects anything except pending:

> `"Runtime request ${command.requestId} is ${runtimeRequest.status}."`

`apps/server/src/orchestration-v2/Orchestrator.ts:7248–7272`.

It changes the request to `"resolved"` and records the answer: `7294–7320`. Dispatch is serialized by `threadDispatch.withLock(commandThreadId(command), …)`: `10866–10871`.

**INFERENCE:** first committed answer wins; the second command sees resolved status and fails. This is an ordinary `OrchestratorDispatchError`, not a dedicated already-resolved error. MCP may fail earlier with `"The pending user-input request was not found"`: `handlers.ts:57–69`.

Same-command retries use stored receipts/events: `Orchestrator.ts:10669–10680,10701–10719`. Stale cancellation also cannot erase an already answered question: `EventSink.ts:264–301`.

**4. Resolution provenance and presentation**

No responder identity or reason exists in the request, command, or answer-history payload: `packages/contracts/src/orchestrationV2.ts:1029–1047,2966–2973`; `providerPolicy.ts:78–83`. Stored events retain `commandId`, not caller identity: `orchestrationV2.ts:1990–1993`.

**Trap:** message-mode answers are dispatched with `createdBy: "user", creationSource: "server"` even when entered through MCP: `Orchestrator.ts:7442–7453`.

**INFERENCE — additions needed:** trusted responder metadata captured at WS/MCP boundaries, carried through the command and persisted resolution; reason supplied by the orchestrator caller; propagated into answer-history presentation. MCP already has authenticated caller context through `loadCaller`: `threadAccess.ts:70–98`. Product schema and reason requirements remain main-agent decisions.

Presentation anchors:

- Resolution updates request, node and turn item; `questionAnswer` stores answers, attachments and question text: `Orchestrator.ts:7294–7376`.
- Runtime projection persists JSON: `ProjectionStore.ts:2320–2354`.
- Client fallback reconstructs history from resolved runtime answers: `packages/client-runtime/src/state/threadRequests.ts:131–160`; pending selector excludes resolved requests: `72–75`.
- Shared MCP labels: `"Answering"/"Answered pending questions"`: `packages/shared/src/t3McpToolPresentation.ts:280–282`.
- Work-log recognizes question/approval items: `packages/client-runtime/src/work-log/presentation.ts:435–437`.
- Web labels `"Answered questions"`: `apps/web/src/session-logic.ts:554–559`; timeline displays answer preview and `QuestionAnswerHistory`: `components/chat/MessagesTimeline.tsx:4021–4025,5743–5744`.

**5. Blocking, wake-up and deadlines**

Codex’s server-request handler awaits `Deferred.await(answers)` before returning its protocol response: `CodexAdapterV2.ts:5480–5494`; responding completes that deferred: `7101–7112`. The app-server client awaits the handler before encoding its response: `packages/effect-codex-app-server/src/client.ts:187–189`.

**INFERENCE:** the asking tool continuation blocks and resumes on answer; this does not imply every activity in the provider session stops.

Claude similarly awaits answers, racing abort; success returns SDK `"allow"` plus updated answers: `ClaudeAdapterV2.ts:2361–2371,7080–7104`. ACP uses `Deferred.await`: `packages/provider-acp/src/server/adapter.ts:5016–5033`. No sleep loop is needed.

Live delivery occurs **after persisted resolution** through `RuntimeRequestService`, which explicitly requires `"resolved"` before calling the adapter: `apps/server/src/orchestration-v2/RuntimeRequestService.ts:88–122`. Message-mode questions instead steer active work or enqueue a new message: `Orchestrator.ts:7412–7457`.

No request deadline field exists: `orchestrationV2.ts:1029–1047`. **INFERENCE:** these Codex/Claude wait paths have no application question timeout; provider-internal limits remain unverified. `"expired"` can mean session loss, not elapsed deadline: `ProviderSessionManager.ts:267–270,693–719`.

**Open judgments for main:** provenance schema/reason policy; reliable launcher wake delivery; remote authority and routing. Current pending tools have **no `host` parameter** (`tools.ts:130–173`), and host-thread service exposes list/read/wait/send/interrupt only (`HostThreadsMcpService.ts:120–139`). **INFERENCE:** host-aware pending responses require extending the existing routing surface.

## R2 Launcher lineage and parent notification (task q13-wp0-r2-lineage)

Paths below are relative to `/Users/jun/.goat/worktrees/goat/goat-question-escalation`. Research was read-only.

### 1. Launcher implementations and recorded lineage

The lineage contract contains only `parentThreadId`, `relationshipToParent: "fork" | "subagent" | null`, and `rootThreadId`; there is no launcher relationship variant. `packages/contracts/src/orchestrationV2.ts:108–112`.

| Tool                     | Implementation                                                                                                                                                       | New thread’s lineage / other origin records                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `goat_thread_launch`     | `apps/server/src/mcp/toolkits/project/handlers.ts:56` → `ThreadMessageIntake.launchThread` at `:138` → `apps/server/src/orchestration-v2/ThreadLaunchService.ts:836` | Ordinary `thread.create`: parent/relationship null, root=self (`apps/server/src/orchestration-v2/Orchestrator.ts:2212–2215`). **Calling thread is recorded**, conditionally, as initial-message `senderThreadId: caller.id` (`project/handlers.ts:147–155`), forwarded into message dispatch (`ThreadLaunchService.ts:889–891`). Without an initial message, that origin record is absent. |
| `create_threads`         | `apps/server/src/mcp/toolkits/orchestrator/handlers.ts:92–96` → `apps/server/src/mcp/OrchestratorMcpService.ts:2161`                                                 | Also ordinary `thread.create`, hence null/null/self (`OrchestratorMcpService.ts:2206–2225`; `Orchestrator.ts:2212`). Optional prompt records `senderThreadId` (`OrchestratorMcpService.ts:2247`). Additionally issues `thread.created.record` with calling thread/run/node IDs (`:2271–2282`), producing a **parent timeline** `thread_created` item (`Orchestrator.ts:7133–7145`).        |
| `delegate_task`          | `orchestrator/handlers.ts:33–37` → `OrchestratorMcpService.ts:1883` → `delegated_task.request` (`:1918–1933`)                                                        | Uses `makeSubagentChildThread` (`Orchestrator.ts:6583–6595`): parent=caller, relationship=`"subagent"`, root=inherited parent root, `forkedFrom={type:"node",nodeId}` (`packages/provider-core/src/server/subagentProjection.ts:66–74`). Parent owns an `app_owned` task row with child ID (`Orchestrator.ts:6599–6614`).                                                                  |
| `goat_ssh_thread_launch` | `apps/server/src/mcp/toolkits/ssh/handlers.ts:54–75` → `apps/server/src/sshRemote/SshRemoteDispatch.ts:611–622`                                                      | Calls remote `goat_thread_launch`, so remote lineage is ordinary null/null/self. **No origin thread/environment/callback is passed** in the enumerated arguments (`SshRemoteDispatch.ts:614–622`). Remote credential is an outside MCP-client session carrying a ceiling (`:384–388`), not a thread credential.                                                                            |

**Trap:** message `senderThreadId`, parent timeline creation records, and thread lineage are three distinct records—not interchangeable launcher identity.

### 2. Delegated completion delivery and possible question reuse

The completion path is event-driven:

1. `delegate_task` sets `completionWake="always"` for async, `"settled_only"` for blocking waits. A wait timeout upgrades to `"always"` (`apps/server/src/mcp/OrchestratorMcpService.ts:1930–1933,1966–1980`). Blocking waits consume stored-event streams, filtering terminal task status (`:1437–1467`).
2. A subscription observes terminal **`run.updated`** events (`apps/server/src/orchestration-v2/Orchestrator.ts:10940–10954`). `handleTerminalRun` calls `finalizeAppOwnedSubagent` under the parent lock (`:10920–10922`).
3. Finalization requires subagent lineage and `forkedFrom.type==="node"`, then derives terminal task status (`:9782–9799`). It stores task result and plans a completion-delivery cohort (`:9862–9885`). Events include **`subagent.updated`**, **`run.updated`**, optional **`message.updated`**, and **`context-transfer.created`** with transfer type `"subagent_result"` (`:9932–9946,9961–10003,10054–10060`).
4. `offerDelegatedCompletionDelivery` offers `ProviderContinuationRequests` with `delivery:"message_text"` and parent-run/generation/message identity (`:1072–1082`).
5. `ProviderContinuationService` dispatches **`message.dispatch`**, initially `queue_after_active`, with `delegatedCompletion` metadata (`apps/server/src/orchestration-v2/ProviderContinuationService.ts:129–143`).
6. Under the thread lock, routing changes to `steer_active` only when all tasks use `"always"` and the live session supports steering **without interrupting tools** (`Orchestrator.ts:4746–4778`). Otherwise blocking work causes queuing (`:4870–4877`).
7. Effects are **`provider-turn.steer`** (`Orchestrator.ts:4044–4055`) or **`provider-turn.start`** when queued work is promoted (`:1865–1869`). The effect worker calls the corresponding control/start services (`apps/server/src/orchestration-v2/EffectWorker.ts:152–154,205–213`). Successful delegated steering dispatches **`notification.delivery.accept`** (`:225–231`); a turn-completed race redispatches the same message into the queue (`:234–278`).
8. Reading terminal status acknowledges completion ownership (`OrchestratorMcpService.ts:1400–1421`). Mailbox delivery is explicitly **at least once** (`apps/server/src/orchestration-v2/NotificationMailbox.ts:7–10`).

**Parent-model text:** the notification’s base prompt is:

> `Delegated task <taskId> reached a terminal state. Use task_status with taskId <taskId> to read the result.`

Plural wording lists IDs and requests each result (`Orchestrator.ts:568–572`). Steering passes persisted `message.text` to `steerTurn` (`apps/server/src/orchestration-v2/ProviderTurnControlService.ts:317–328`). New turns may prepend ordinary handoff/restart context, followed by `User message:\n<text>` (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1171–1180`). The notification metadata is therefore not itself a structured model-facing tool event.

**INFERENCE:** the delivery primitives could carry a question notification, but current completion machinery cannot be reused unchanged: it requires terminal tasks and completion cohorts, and special active steering is gated on `delegatedCompletion` (`Orchestrator.ts:9782–9799,4748–4752`). The existing notification schema has `source/outcome/summary/detail`, without typed question/request/provenance fields (`packages/contracts/src/orchestrationV2.ts:1069–1116`).

### 3. How MCP identifies the caller and enforces ceilings

Caller identity comes from authentication, not the `mcp:` ID prefix:

- `McpSessionRegistry.issue` binds a random bearer credential to `threadId`, provider session, and provider instance (`apps/server/src/mcp/McpSessionRegistry.ts:124–146`).
- HTTP middleware resolves the bearer via registry or outside-client authenticator and provides **`McpInvocationContext`** to handlers (`apps/server/src/mcp/McpHttpServer.ts:157–166,180–182`).
- `orchestrator_capabilities.parentThreadId` means **the calling thread**, not its lineage parent (`packages/contracts/src/orchestratorMcp.ts:537–539`; `OrchestratorMcpService.ts:1840–1848`).
- `mcp:<uuid>` is generated by `newCommandId`; launch uses that command ID as the new thread ID (`apps/server/src/mcp/threadAccess.ts:201–203`; `project/handlers.ts:62–64`).
- Live thread modes are loaded from its shell; outside callers use their approved client ceiling (`apps/server/src/mcp/threadAccess.ts:70–98`). Mutations reject read-only clients and inactive/provider-mismatched callers (`McpToolAccess.ts:100–122`; `threadAccess.ts:121–132`).
- Target mutations inject **`DispatchModeLimit`** (`McpToolAccess.ts:188–203`), rechecked inside orchestration dispatch (`Orchestrator.ts:10722–10732`). Launch modes resolve against caller limits (`McpToolAccess.ts:240–248`); SSH propagates `callerRuntimeMode` into the remote session ceiling (`ssh/handlers.ts:72`; `SshRemoteDispatch.ts:388`).

### 4. Agent instruction text and relevant quotes

The shared text is **`packages/provider-core/src/server/orchestrationInstructions.ts:3–39`**. Codex injects it as additional-context key `t3_code_orchestration` (`apps/server/src/provider/CodexDeveloperInstructions.ts:218`).

- SSH guidance: “**Wait on it rather than polling**”; “**The remote thread cannot report back to you on its own**” (`orchestrationInstructions.ts:30`).
- General guidance: “**Keep polling/wait loops bounded, do not duplicate active work**” (`:32`).
- Delegate tool description: “**so end the turn instead of polling or spawning watchers**”; “**mode='wait' blocks until completion or timeout**” (`apps/server/src/mcp/toolkits/orchestrator/tools.ts:76`).
- Pending-question descriptions: “**Approval requests are not included**”; “**Answer with goat_pending_request_respond**”; “**This cannot approve a permission request**” (`apps/server/src/mcp/toolkits/thread/tools.ts:154,163,172`).
- Native Codex guidance: “**Use the `request_user_input` tool only when it is listed in the available tools for this turn**” (`CodexDeveloperInstructions.ts:179`).

**Surprise:** pending-question and `request_user_input` guidance lives in tool descriptions/native mode instructions, not the shared orchestration block.

### 5. Existing question/attention notifications and remaining gaps

- Own-thread pending questions set `hasPendingUserInput`; sidebar status becomes `"input"` (`packages/client-runtime/src/state/models.ts:259`; `apps/web/src/components/Sidebar.logic.ts:983–988`). The notification coordinator emits **“Input needed”**, sound, and an off-thread toast linking to that thread (`apps/web/src/components/ThreadNotificationCoordinator.tsx:136–178,195–202`).
- Parent UI already aggregates descendant subagent questions within its environment, excluding provider-native subagents (`packages/client-runtime/src/state/threadShell.ts:142–168`). Web displays **“Subagent needs input” / “Open question”** (`apps/web/src/components/ChatView.tsx:7435–7461`); mobile has the equivalent navigation banner (`apps/mobile/src/features/threads/ThreadDetailScreen.tsx:514–528`).
- Current pending-request tools have **no `host` parameter** (`thread/tools.ts:130,155,164,173`). Response handler accepts only pending `user_input`, excluding approvals (`thread/handlers.ts:57–61,219–228`).
- **Provenance gap:** message-based answers are currently dispatched as `createdBy:"user"` even through MCP (`Orchestrator.ts:7443–7453`). Live answers use `runtime-request.respond` effects and `respondToRuntimeRequest` (`:7463–7471`; `RuntimeRequestService.ts:118–121`).
- **INFERENCE:** first committed answer wins through per-thread locking and rejection of non-pending requests (`Orchestrator.ts:10868–10870,7267–7272`).

**Open judgments for main:** launcher-origin representation separate from lineage; SSH reverse delivery ownership; question-event acknowledgment/deduplication; responder/reason provenance; human-only classification above existing mode ceilings.

## R3 Host routing, #5 snapshot, initiative quotes (task q13-wp0-r3-host)

Read-only inspection completed; no files changed or checks run. Paths below are relative to `/Users/jun/.goat/worktrees/goat/goat-question-escalation`, except explicitly named sibling and initiative paths.

**1. Host routing, authorization, compatibility, and minimal pending-request extension**

The important distinction: **thread routing uses `callHostTool`, not `callRemote` directly**. `HostThreadsMcpService` calls `dispatch.callHostTool` (`apps/server/src/mcp/HostThreadsMcpService.ts:173–201`). The older `callRemote` helper lacks its pre-request authorization callback, retry logic, and preserved `remoteCode` (`apps/server/src/sshRemote/SshRemoteDispatch.ts:405–436,656–740`).

Authorization has two layers:

- Remote reads use `readsOrReachesHost`: reaching another machine requires orchestration capability, a client approved beyond read-only, and a live caller. Local reads retain normal read access (`apps/server/src/mcp/McpToolAccess.ts:125–153`; `apps/server/src/mcp/threadAccess.ts:55–99,121–132`).
- Remote writes additionally require `interactionMode === "default"` because the remote session carries only a runtime ceiling. Local target checks are skipped for remote IDs; the destination checks its own thread (`apps/server/src/mcp/HostThreadsMcpService.ts:147–165`; `apps/server/src/mcp/toolkits/orchestrator/handlers.ts:18–23,125–143`).

`callHostTool` resolves a safe, known SSH alias, authorizes, ensures the environment, and selects a session cached by **alias + runtime ceiling**. Sessions request `runtimeModeCeiling`, last 12 hours, and refresh within ten minutes of expiry. Writes are refused when the remote cannot apply that ceiling. Authorization runs again immediately before `tools/call`, after initialization; a changed runtime mode sends no tool request (`apps/server/src/sshRemote/SshRemoteDispatch.ts:178–180,303–320,376–398,656–695`; `apps/server/src/mcp/AcpMcpStdioBridge.ts:154–179`).

The invocation is authenticated HTTP POST to the remote `/mcp`, with JSON-RPC:

```json
{
  "method": "tools/call",
  "params": { "name": "goat_thread_read", "arguments": { "threadId": "..." } }
}
```

The bridge initializes first and carries session/protocol headers (`apps/server/src/mcp/AcpMcpStdioBridge.ts:120–179`). Routing preserves each tool name—`goat_thread_list/read/wait/send/interrupt`—and removes `host`/`allHosts` from forwarded arguments. Results are schema-decoded and tagged with `host`; remote list items are also tagged (`apps/server/src/mcp/HostThreadsMcpService.ts:96–117,203–259,316–377`).

Error mapping:

- Invalid/unknown alias → `invalid_request`.
- SSH, HTTP/transport failure, or answer timeout → `host_unavailable`.
- Caller runtime change → `runtime_mode_escalation_denied`.
- Remote tool refusal → its recognized `OrchestratorMcpFailureCode`; unknown/missing code → `orchestration_error`.
- Invalid result schema → `orchestration_error`.
- HTTP 401 refreshes the session and retries once; repeated rejection becomes a remote refusal.

Anchors: `apps/server/src/mcp/HostThreadsMcpService.ts:49–68,103–110`; `apps/server/src/sshRemote/SshRemoteDispatch.ts:689–735`. Structured content takes precedence over JSON text when extracting remote results/errors (`apps/server/src/sshRemote/SshRemoteDispatch.ts:250–279`).

Normal calls receive a **120-second answer deadline**. Wait defaults to ten minutes, clamps to 1 ms–one hour, and gives transport an additional minute. A remote `timedOut:true` answer is distinct from transport silence. The answer deadline wraps the MCP exchange, not preceding environment/session setup (`apps/server/src/mcp/HostThreadsMcpService.ts:35–41,336–349`; `apps/server/src/sshRemote/SshRemoteDispatch.ts:660–695`).

**Test harness:** `runService` injects mocked local service, dispatch, and thread management; records calls; executes the supplied authorization before the fake remote answer. Fixtures provide a live full-access caller and configurable interaction mode/connected hosts (`apps/server/src/mcp/HostThreadsMcpService.test.ts:67–132`). Tests cover plan-write refusal, stripped arguments/result tagging, all-project remote listing, merged partial success, and cursor rejection (`…/HostThreadsMcpService.test.ts:135–278`). Transport behavior is separately tested: preserved remote codes, RPC refusal, 401 refresh, authority changes, and legacy ceiling refusal (`apps/server/src/sshRemote/SshRemoteDispatch.test.ts:558–651`). These were inspected, not executed.

**INFERENCE—minimal extension:**

1. Add optional `host` to pending list/read/respond schemas, reusable input/result schemas, and host-tagged results.
2. Extract existing local pending handlers into a service; add host branches using `callHostTool`, matching tool names, stripped host, schema decoding, and `writes:false/false/true`.
3. Use `readsOrReachesHost` for list/read; make respond’s target selector skip remote IDs while retaining local `writesThreads` checks.
4. Wire the service into toolkit registration and add focused routing/authorization tests.

The current pending implementation is handler-local and has no host fields; respond accepts only target plus answers (`apps/server/src/mcp/toolkits/thread/tools.ts:130–175`; `apps/server/src/mcp/toolkits/thread/handlers.ts:203–232`; `apps/server/src/mcp/McpHttpServer.ts:816–825`). With `host`, an explicit remote `threadId` is necessary: the remote outside client has no calling thread (`apps/server/src/mcp/threadAccess.ts:158–168`).

**Older remote trap:** unknown new respond fields may be **discarded**, allowing an answer without provenance, or rejected by strict validation. The vendored MCP implementation chooses `"error"` versus `"ignore"` from `Tool.Strict`; current pending tools do not declare strictness (`.repos/effect-smol/packages/effect/src/ai/McpServer.ts:1845–1855`; `apps/server/src/mcp/toolkits/thread/tools.ts:169–176`). **INFERENCE:** strict rejection travels as RPC refusal, ultimately `orchestration_error`; ceiling-incompatible remotes fail earlier. There is currently no respond-field capability negotiation (`apps/server/src/sshRemote/SshRemoteDispatch.ts:682–735`). Compatibility policy remains for main to decide.

**2. Fan-out and pending-request applicability**

`allHosts` uses the process’s remembered hosts, populated after environment bootstrap for launch/call—not every SSH-config host (`apps/server/src/sshRemote/SshRemoteDispatch.ts:556–559,660–665,742`). It rejects `host`, `projectId`, or cursor; queries local all-project threads and every connected host concurrently with `"unbounded"` concurrency (`apps/server/src/mcp/HostThreadsMcpService.ts:262–296`).

Remote failures become `{host,code,message}` entries in `unavailableHosts`; any remote failure qualifies, not only connectivity failures. Local failure fails the operation. Successful pages merge newest-first, with descending thread-ID and ascending host tie-breaks; totals exclude failed hosts, `nextCursor:null`, and `truncated` reflects successful totals (`apps/server/src/mcp/HostThreadsMcpService.ts:73–93,297–313`).

**INFERENCE:** pending requests can use this transport/failure pattern, but current pending-list semantics cannot support environment-wide discovery: it lists one thread and returns only request IDs (`apps/server/src/mcp/toolkits/thread/tools.ts:151–156`; `…/handlers.ts:203–210`). A cross-host list needs environment-wide enumeration and actionable `{host,threadId,requestId}` items. Chaining through capped thread-list pages could miss questions. Scope, ordering, and limits remain product decisions.

**3. Issue #5 sibling snapshot**

Executed the requested commands against `/Users/jun/.goat/worktrees/goat/goat-remote-report-delegation`:

```text
git status --short → empty
git log --oneline -3 →
070941cae test(ssh): give node-mode launch tests their own pick port
2d28ef593 style(devlog): format planning records so goat-check passes
37073207d docs(devlog): record goat CI speedup unit
git ls-remote origin goat/remote-report-delegation → empty
```

The issue-specific plan directory contains only `devlog/_plan/261012_remote-report-delegation/001_research.md`. Its findings:

- **Origin record shape: not yet present.** Research states “Launch carries no origin identity” (`sibling/devlog/_plan/261012_remote-report-delegation/001_research.md:20`); directly confirmed launch inputs have no origin field (`sibling/apps/server/src/orchestration-v2/ThreadLaunchService.ts:75–97`).
- **Report-scoped token: not yet present.** Existing dispatch uses runtime-ceiling sessions; the research’s proposed outbox approach explicitly avoids new remote credentials (`sibling/devlog/_plan/261012_remote-report-delegation/001_research.md:15,47`).
- **Delivery modes: research inputs only:** steer into active turn, defer to next turn, notify only. No shared enum exists yet (`same research file:8,33`).
- **New reporting tool names/contracts: not yet present.** The document references existing `goat_thread_wait` and an unnamed “new report tool”; its remote outbox/origin-drain approach is explicitly under **Inferences** (`same research file:45–49`).

Thus no implemented reverse-report interface should be assumed from this snapshot.

**4. Initiative exact quotations**

`/tmp/goat_initiative` already existed; no clone or writes were needed.

`/tmp/goat_initiative/docs/010_goals.md:17`:

> - 작업 중 생기는 승인 요청과 모호한 질문은 최대한 원래 작업 에이전트가 판단한다. 사람이 꼭 필요할 때만 그 에이전트가 사람을 태그해서 묻는다. (확정, 라운드 3)

`/tmp/goat_initiative/docs/010_goals.md:18`:

> - 태그 대상은 기본적으로 그 작업을 지시한 사람이고, 지시가 들어온 원래 채널에서 태그한다. 에이전트가 상황에 따라 다른 사람이나 채널을 고를 수 있다. (확정, 라운드 4)

`/tmp/goat_initiative/docs/030_design.md:35`:

> - 권한: 모델 판단을 기본으로 믿고, 시스템은 넘을 수 없는 상한 세 가지만 강제한다. ① 새 작업은 사람 입력만 만든다. ② 작업 권한은 요청자의 상한을 넘지 못한다. ③ push, 배포, 외부 전송은 요청자 권한에 그 행동이 있을 때만 한다. 그 안에서는 승인 절차를 늘리지 않는다. (확정, 라운드 6. research/060)

**Open judgment for main:** the initiative permits agent judgment on approvals, while the supplied #13 scope reserves permission approvals for humans. Reconcile that policy explicitly. Current pending tools exclude approvals and resolve only pending user-input requests (`apps/server/src/mcp/toolkits/thread/tools.ts:154,172`; `…/handlers.ts:57–69`).

## Main spot-checks ✓

- `apps/server/src/mcp/toolkits/thread/handlers.ts:52-69,203-232` — pending tools are handler-local, user_input only, no host.
- `apps/server/src/orchestration-v2/Orchestrator.ts:7248-7272` — non-pending respond is rejected with `Runtime request <id> is <status>.`; `:7442-7453` message-mode answers dispatch as `createdBy: "user"`.
- `apps/server/src/orchestration-v2/Orchestrator.ts:2330-2370` — PR-watch wake dispatches `message.dispatch` with `notification`, `queue_after_active`, `createdBy: "agent"`, `creationSource: "server"`: the template for the question wake.
- `packages/contracts/src/orchestrationV2.ts:1050-1116` — `OrchestrationV2NotificationSource` is a `kindUnionWithFallback`; unknown kinds decode as `background_task` on old clients.
- `apps/server/src/ws.ts:1836-1845` — client commands pass through `ThreadManagementService.withCreationProvenance`; the stamping point for `respondedBy: user`.
- `apps/server/src/orchestration-v2/ThreadManagementService.ts:681-760` — `waitForThread` waits only for terminal `run.updated`/`thread.deleted`.
- `apps/server/src/mcp/HostThreadsMcpService.ts:173-201,316-377` — host routing via `dispatch.callHostTool`, `withoutHost`, schema-decoded remote results tagged with `host`.
- `apps/server/src/sshRemote/SshRemoteDispatch.ts:611-622` — remote `goat_thread_launch` receives no origin.
- `apps/server/src/mcp/McpSessionRegistry.ts:101` — the server knows its own `environmentId` (`ServerEnvironment.getEnvironmentId`).
- Sibling #5 worktree: clean at `070941cae`, only `devlog/_plan/261012_remote-report-delegation/001_research.md`; `git ls-remote origin goat/remote-report-delegation` is empty (2026-10-12).

## Verifiers

Run at P on base `070941cae` after `vp i` (the worktree had no node_modules). `node_modules/.bin` contains a Linux-only `rg` shim that fails on macOS, so append it to PATH (`B=$PWD/node_modules/.bin` and call `$B/vp`, `$B/tsc`) instead of prepending it.

| Command                                                                                                      | Exit         | Reads the change target?                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------- |
| `$B/vp test run apps/server/src/mcp/HostThreadsMcpService.test.ts apps/server/src/mcp/toolkits/core.test.ts` | 0 (22 tests) | yes: test files are direct arguments; each wp names its own files |
| `$B/vp lint apps/server/src/mcp/toolkits/thread/handlers.ts packages/contracts/src/orchestratorMcp.ts`       | 0            | yes: paths are direct arguments                                   |
| `(cd packages/contracts && $B/tsc --noEmit)`                                                                 | 0 (~1.3 s)   | yes: package tsconfig includes `src`                              |
| `(cd apps/server && $B/tsc --noEmit)`                                                                        | 0 (~13 s)    | yes: package tsconfig includes `src`                              |
