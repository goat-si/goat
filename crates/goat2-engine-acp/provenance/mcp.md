# GOAT MCP server choice for ACP agents

| GOAT 2 path | v1 path @ 916b5ccc1b2 | Kind |
|---|---|---|
| crates/goat2-engine-acp/src/mcp.rs (mcp_servers_for) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1475-1494 (sessionMcpServers) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp.rs (server lists, name, env names) | packages/provider-acp/src/server/mcpContext.ts:39-75; apps/server/src/mcp/AcpMcpStdioBridge.ts:570-579 | ported-to-Rust |
| crates/goat2-engine-acp/src/flavor.rs (prefers_http_mcp) | packages/provider-acp/src/server/adapterFlavor.ts:126 (preferHttpMcp) | ported-to-Rust |

Bridge binary lookup ($GOAT2_ACP_MCP_BRIDGE, else beside the executable) is GOAT 2's replacement for v1's self-invocation (selfInvocationArgs).
| crates/goat2-engine-acp/src/mcp_over_acp.rs | packages/provider-acp/src/server/mcpOverAcpBridge.ts (connect/message/notification/disconnect/dispose, limits, errors) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp.rs (acp branch) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1487-1493; mcpContext.ts:61 | ported-to-Rust |
MCP-over-ACP keeps the v1 wire (mcp/connect + connectionId), not the later connection-less schema.
