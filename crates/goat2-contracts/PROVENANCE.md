# Provenance

goat2-contracts lifts shapes from GOAT v1 once (no chasing). Base commit:
goat-si/goat `origin/dev` 916b5ccc1b2b6d4ecd991ab1573172bab8fb1cc4 (2026-11-28), read with `git show origin/dev:<path>`.
All rows below are "ported to Rust" (serde + ts-rs + schemars); field names and literals are kept.

| GOAT 2 | GOAT v1 source (packages/contracts/src/) | Change |
|---|---|---|
| `turn_item.rs` `TurnItem`, `TurnItemBody` and helpers | `orchestrationV2.ts` `OrchestrationV2TurnItem`, base fields, `OrchestrationV2TurnItemStatus`, `OrchestrationV2ProviderRef`, `OrchestrationV2CommandAction`, `OrchestrationV2ProviderFailure`, `OrchestrationV2ProviderRetry`, plan/question/file-change structs; `providerPolicy.ts` request kind and approval option; `chatAttachment.ts`; `assistantMessagePhase.ts`; `orchestrationV2Attribution.ts` | Subset of 15 variants Part 1 produces. Base drops `nodeId` and tool icon/surface fields. Dedup markers, channel, scheduling, workflow and handoff fields dropped. Attachments gain an optional `blob` locator. |
| `capabilities.rs` | `providerCapabilityParts.ts`; `orchestrationV2.ts` `OrchestrationV2ProviderCapabilities`, checkpoint, runtime-policy, identity structs; `memory.ts` `MemoryProviderCapabilities` | Same field names, optionality and decoding defaults. |
| `model.rs` `ModelSelection`, `ProviderOptionSelection`, `ProviderOptionSelectionValue`, `RuntimeMode` | `modelSelection.ts` (wire shape), `model.ts`, `providerPolicy.ts` `RuntimeMode` | Legacy `provider` key and options-object decoding not carried (GOAT 2 never wrote them). |
| `card.rs` `EngineConfig` `{providerInstanceId, modelSelection, runtimeMode, cwd}`, `ThreadCard.latestAnswerExcerpt`, `ThreadCard.archivedAt` | `orchestrationV2.ts` `OrchestrationV2AppThread` | Card is the PRD's reduced projection; shared fields keep v1 names. |
| `log.rs` `RunOutcome::Completed`, `ChildResultStatus::Completed` | `orchestrationV2RunStatus.ts` (`completed`) | `unknown` and `interrupted_by_restart` are GOAT 2 settlement states. |
| `log.rs` `RequestOutcome` `accept / acceptForSession / acceptAlways / decline / cancel` | `providerPolicy.ts` `ProviderApprovalDecision` | Plus GOAT 2 `answered / decided / resend / dropped`. |
| `log.rs` `DecisionOption {id, label, consequence}`, `recommended` | `decisions.ts` `DecisionOption`, `DecisionItem.recommended` | Carried on `request.opened`. |
| `subscribe.rs` `AgentSurfaceErrorCode`, `CommandError {code, reason, message, retryable, details?}` | `agentSurface/envelope.ts` `AgentSurfaceErrorCode`, `AgentSurfaceError` | Used as `command_result.error`. |
| `bot.rs` `BotProfile {botId, name, purpose, role, sessionThreadId, defaultModelSelection}`, `BotRole` | `botProfile.ts` `BotProfile`, `BotRole` | `face` is GOAT 2 (v1 `avatar`); instructions/tools/environment fields not in Part 1. |
| `card.rs` `EngineDriver` (Part 2) | `apps/web/src/components/settings/providerDriverMeta.ts` and provider client modules (`ProviderDriverKind` values) | Local kinds only (codex, claudeAgent, grok, fx, antigravity, opencode, cursor, muse, pi, omo, acpRegistry + agentId); cloud kinds are Part 3. |
| `probe.rs` `ProviderProbeResult`, `ServerProviderAuth`, `ServerProviderModel`, `ServerProviderState`, `ServerProviderAuthStatus`, `ServerProviderCli`, `ModelCapabilities`, `ProviderOptionDescriptor`, `ProviderOptionChoice` | `server.ts`, `serverProviderState.ts`, `model.ts`, `acpRegistry.ts` (`AcpRegistryUrlAuthAction` as `auth.action`) | Probe result is the `ServerProvider` subset a probe can know; `binaryPath` is GOAT 2. v1 string length checks (`AcpRegistryUrlAuthAction` ids, URL, message, timestamps) are not carried; the driver bounds registry input. |
| `decision.rs` `DecisionItem`, `DecisionStatus`, `DecisionRequestInput`, `DecisionAnswerInput`, `DecisionEscalateInput` | `decisions.ts`, `agentSurface/entries/decision.ts` | Environment/host routing and `requiredProfile` not carried (Part 2 is local, no permission profiles). Option count (1-20) and reason (trimmed like JavaScript `trim`, then 1-2000 UTF-16 code units as v1 counts them) are enforced in serde, which returns the trimmed reason; the schema carries the same option count and blank rule, and its reason `maxLength` counts code points (the closest JSON Schema bound), so it is looser only for characters outside the BMP, and it does not trim, so padded input near the limit passes only serde; v1 `TrimmedNonEmptyString` checks on ids, titles and labels are not carried (the host validates MCP input). |
| `attention.rs` `GoatBotAlerts`, `ChannelAttentionKind`, `ChannelAttentionEvent` | `channelBotAttention.ts` | `taskId` -> `threadId`; `request` keeps `requestId`/`threadId`/`kind` (v1 `ChannelTaskApprovalRef`), `host`/`environmentId` not carried (local); `generation` is v1 `Int` within +/-(2^53-1). |
| `card.rs`, `log.rs` (events, Fold), `subscribe.rs` (frames, cursors), `limits.rs` | goat-si/goat2-design `prd-src/part1/{model,storage,runtime}.md`, goat2 `structure/` | New for GOAT 2. |

## Provider and bot runtime wire (v1 916b5ccc1b2)

- `provider.rs`: `providerSetup.ts` auth methods, flow and install; `acpRegistry.ts` registry search/prepare; `server.ts` setup and provider entry. Entry is the owner-approved subset: probe, capabilities and ACP id are composed for GOAT 2. Method fields retain v1; auth interaction is carried. Registry prepare retains the literal `prepared: true`.
- `bot.rs`: `channelBotNotes.ts` notes fields, excluding `source` because Part 2 has no channels; `botProfile.ts` instructions and its UTF-8 byte limit. `log.rs` notification source literals from `apps/server/src/channels/ChannelSessionFirst.ts`.
- `subscribe.rs`: GOAT 2 subscription and commands map to `rpc.ts`, `server.ts`, `providerSetup.ts`, `acpRegistry.ts`, `channelGateway.ts`; `write_bot_notes` and `mark_read` are GOAT 2-only. A stale notes revision yields conflict / notes_changed. Card openAsks and unread are GOAT 2-only.

- `usage.rs` `ThreadTokenUsageSnapshot`, `TokenUsageCost`: v1 `packages/contracts/src/providerRuntime.ts:260-284`, ported to Rust; safe integer limits match the JavaScript wire range.
- `log.rs` `RunFinished.tokenUsage`, `card.rs` `ThreadCard.contextUsage`: v1 run and provider-thread usage projections; `subscribe.rs` `thread_usage` models live usage with host receipt time, analogous to `packages/client-runtime/src/state/contextWindow.ts:46-90`.

- `subscribe.rs` `ContentStreamKind`: v1 `packages/contracts/src/providerRuntime.ts:83-91`, ported to Rust with identical wire literals.
