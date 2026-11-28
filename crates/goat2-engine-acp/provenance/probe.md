| GOAT 2 path | v1 path@916b5ccc1b2 | treatment |
| --- | --- | --- |
| `src/probe.rs` `probe_fingerprint` | `packages/provider-acp-registry/src/server/probeFingerprint.ts:9-20` | ported-to-Rust; JSON object key ordering is Rust serde ordering and is not promised to match v1's digest bytes |
| crates/goat2-engine-acp/src/probe.rs (open_probe, AcpProbeSession, AcpProbeFailure, timing constants) | packages/provider-acp-registry/src/server/probe.ts:72-77, 389-546 | ported-to-Rust |
| crates/goat2-engine-acp/src/engine.rs (for_probe, wait_for_advertisements, available_commands, delete_session) | packages/provider-acp-registry/src/server/probe.ts:410-516; packages/provider-acp/src/server/AcpSessionRuntime.ts:1902-1915 | ported-to-Rust |
Gap: url-mode sign-in elicitations outside a turn are not captured as a probe auth action yet (v1 probe.ts:440-466).
