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
| `card.rs`, `log.rs` (events, Fold), `subscribe.rs` (frames, cursors), `limits.rs` | goat-si/goat2-design `prd-src/part1/{model,storage,runtime}.md`, goat2 `structure/` | New for GOAT 2. |
