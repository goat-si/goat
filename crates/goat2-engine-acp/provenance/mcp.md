# GOAT MCP server choice for ACP agents

| GOAT 2 path | v1 path @ 916b5ccc1b2 | Kind |
|---|---|---|
| crates/goat2-engine-acp/src/mcp.rs (mcp_servers_for) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1475-1494 (sessionMcpServers) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp.rs (server lists, name, env names) | packages/provider-acp/src/server/mcpContext.ts:39-75; apps/server/src/mcp/AcpMcpStdioBridge.ts:570-579 | ported-to-Rust |
| crates/goat2-engine-acp/src/flavor.rs (prefers_http_mcp) | packages/provider-acp/src/server/adapterFlavor.ts:126 (preferHttpMcp) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp_over_acp.rs | packages/provider-acp/src/server/mcpOverAcpBridge.ts (connect/message/notification/disconnect/dispose, limits, errors) | ported-to-Rust |
| crates/goat2-engine-acp/src/mcp.rs (acp branch) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1487-1493; mcpContext.ts:61 | ported-to-Rust |
| crates/goat2-acp-mcp-bridge/src/lib.rs (bounds, final review finding 18) | apps/server/src/mcp/AcpMcpStdioBridge.ts:496-556 (forks each line; finished fibers leave `running` at once, :500-510); packages/shared/src/mcpResponsePayloads.ts:50-58 | adapted: finished work is reaped before each line, at most 64 requests and 64 replies run at once (one more request is refused, never waited for, so replies the open requests need are still read), the stdout queue holds 256 messages, and a JSON body is capped at 16 MiB; tests `in_flight_requests_are_bounded_and_finished_ones_are_reaped`, `oversized_json_response_fails_the_request` |

Bridge binary lookup ($GOAT2_ACP_MCP_BRIDGE, else beside the executable) is GOAT 2's replacement for v1's self-invocation (selfInvocationArgs).

MCP-over-ACP keeps the v1 wire (mcp/connect + connectionId), not the later connection-less schema.
