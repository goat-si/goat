# Grok ACP (v1 916b5ccc1b2)

| GOAT 2 path | v1 path@916b5ccc1b2 | Method |
| --- | --- | --- |
| src/agents/grok.rs | packages/provider-grok/src/server/xaiMcpToolCall.ts:13-54 | ported-to-Rust, per-update only |
| src/agents/grok.rs | packages/provider-grok/src/server/xaiAcpExtension.ts:50-78,1464-1473 | ported-to-Rust, completion fallback only |

The existing `vendor-flavors.md` records the checkpoint. These additions are partial: v1
normalizes merged tool state and matches completion by session as well as prompt ID; the
current shared driver does neither through the flavor hooks. Rate limit and error completions
end the turn as failures (`FlavorEvent::PromptFailed`, `src/agents/grok.rs` rate_limit/error
branches; the row below), as v1 does (xaiAcpExtension.ts:1283-1301, adapter.ts:434-446).
| crates/goat2-engine-acp/src/agents/grok.rs (PromptFailed for rate_limit/error) | packages/provider-grok/src/server/xaiAcpExtension.ts:1283-1301; packages/provider-grok/src/server/adapter.ts:434-446 | ported-to-Rust |
| crates/goat2-engine-acp/src/agents/xai_requests.rs | packages/provider-grok/src/server/xaiAcpExtension.ts:880-1235 (ask_user_question / exit_plan_mode schemas, extraction, answer normalization, captured response) | ported-to-Rust |
| crates/goat2-engine-acp/src/agents/grok.rs (ext_request_action) | packages/provider-grok/src/server/adapter.ts:171-230 | ported-to-Rust |
| crates/goat2-engine-acp/src/flavor.rs (ExtRequest), engine.rs (on_ext_question, Pending::ExtQuestion, CapturePlan) | packages/provider-acp/src/server/AcpSessionRuntime.ts handleExtRequest; adapterFlavor.ts requestUserInput / captureProposedPlan | ported-to-Rust |
Gap: v1 plan fallback from the last Grok plan file (lastProposedPlanMarkdown, extractGrokPlanMarkdownFromToolCallData) not yet ported.
