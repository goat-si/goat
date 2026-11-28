# Registry agent session behavior

Reference: GOAT v1 commit `916b5ccc1b2`.

| GOAT 2 path | v1 path and lines | Lift |
| --- | --- | --- |
| `crates/goat2-engine-acp/src/registry/mod.rs` | `packages/provider-acp-registry/src/server/adapter.ts@916b5ccc1b2` (213-254, 275-282, 330-360); `packages/provider-acp/src/server/adapter.ts@916b5ccc1b2` (5985-6018) | ported-to-Rust |
| `crates/goat2-engine-acp/src/flavor.rs` | `packages/provider-acp/src/server/adapterFlavor.ts@916b5ccc1b2` (266-268) | ported-to-Rust |
| `crates/goat2-engine-acp/src/engine.rs` | `packages/provider-acp/src/server/adapter.ts@916b5ccc1b2` (5125-5127) | adapted |
| `crates/goat2-engine-acp/src/bin/acp_mock_agent.rs` | `packages/provider-acp-registry/src/server/devinAcp.ts@916b5ccc1b2` (58-63) | adapted |
| `crates/goat2-engine-acp/tests/engine.rs` | `packages/provider-acp-registry/src/server/devinAcp.ts@916b5ccc1b2` (58-63); `packages/provider-acp-registry/src/server/adapter.ts@916b5ccc1b2` (334-361) | adapted |
