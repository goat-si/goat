# Grok ACP (v1 916b5ccc1b2)

| GOAT 2 path | v1 path@916b5ccc1b2 | Method |
| --- | --- | --- |
| src/agents/grok.rs | packages/provider-grok/src/server/xaiMcpToolCall.ts:13-54 | ported-to-Rust, per-update only |
| src/agents/grok.rs | packages/provider-grok/src/server/xaiAcpExtension.ts:50-78,1464-1473 | ported-to-Rust, completion fallback only |

The existing `vendor-flavors.md` records the checkpoint. These additions are partial: v1
normalizes merged tool state and matches completion by session as well as prompt ID; the
current shared driver does neither through the flavor hooks. Rate limit and error completion
are still notices rather than failures, and must not be considered implemented.
| crates/goat2-engine-acp/src/agents/grok.rs (PromptFailed for rate_limit/error) | packages/provider-grok/src/server/xaiAcpExtension.ts:1283-1301; packages/provider-grok/src/server/adapter.ts:434-446 | ported-to-Rust |
