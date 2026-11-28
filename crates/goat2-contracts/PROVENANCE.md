# Provenance

goat2-contracts lifts shapes from GOAT v1 once (no chasing). Base commit:
goat-si/goat `dev` 0ef9f693032336633f69d5708b3c846d738d0cdf (2026-11-28).

| GOAT 2 | GOAT v1 source | Change |
|---|---|---|
| `turn_item.rs` `TurnItem`, `TurnItemBody` and helpers | `packages/contracts/src/orchestrationV2.ts` `OrchestrationV2TurnItem`, base fields, `OrchestrationV2TurnItemStatus`, `OrchestrationV2ProviderRef`, `OrchestrationV2CommandAction`, `OrchestrationV2ProviderFailure`, plan/question/file-change structs; `providerPolicy.ts` request kind and approval option; `chatAttachment.ts`; `assistantMessagePhase.ts`; `orchestrationV2Attribution.ts` | Subset of 15 variants Part 1 produces. Base drops `nodeId` and tool icon/surface fields. Dedup markers (`textOmitted` etc.), channel, scheduling, workflow and handoff fields dropped. Attachments gain an optional `blob` locator. |
| `capabilities.rs` | `packages/contracts/src/providerCapabilityParts.ts`; `orchestrationV2.ts` `OrchestrationV2ProviderCapabilities`, checkpoint, runtime-policy, identity structs; `memory.ts` `MemoryProviderCapabilities` | Same field names, optionality and decoding defaults. |
| `card.rs`, `log.rs`, `subscribe.rs`, `limits.rs` | goat-si/goat2-design `prd-src/part1/{model,storage,runtime}.md` | New for GOAT 2. |
