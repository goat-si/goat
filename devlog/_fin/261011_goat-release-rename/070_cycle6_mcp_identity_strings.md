# 070 — Cycle 6: MCP identity strings (closes goalplan wp6)

Loop spec: satisfy-spec, C1. Trigger: wp5 probe showed the MCP server identifies as GOAT (initialize serverInfo name GOAT), but agent-facing MCP errors still say "T3 Code MCP". Goal: MCP bridge/server errors and the bridge CLI description say "GOAT MCP". Non-goals: product brand text in provider instructions ("You are running inside T3 Code", "## T3 Code orchestration") — wider brand rename, follow-up; live test prompt in OpenCode2OrchestratorV2.live.test.ts. Verifier: rg gate (no "T3 Code MCP" in apps/_/src, packages/_/src outside live tests) + focused tests for touched modules + tsc server/provider-acp. Stop: committed with review PASS.

Hunks (MODIFY, text only):

- apps/server/src/mcp/AcpMcpStdioBridge.ts:113,137,154,218,230 — "T3 Code MCP" → "GOAT MCP".
- packages/provider-acp/src/server/mcpOverAcpBridge.ts:133,170 — same.
- apps/server/src/cli/acpMcpBridge.ts:29 — "Call one GOAT MCP tool from an ACP agent terminal."
- apps/server/src/mcp/McpHttpServer.ts:97 — "A valid GOAT MCP credential is required."

Tests: cd apps/server && vp test run src/mcp/McpHttpServer.test.ts src/mcp/AcpMcpStdioBridge.test.ts (if present) src/cli/_acpMcp_.test.ts (if present); cd packages/provider-acp && vp test run --config ../../vite.config.ts --dir . src/server/mcpOverAcpBridge.test.ts.

## Audit fold

- Add apps/server/src/cli/acpMcpBridge.ts:19 "Bridge T3 Code's MCP endpoint to stdio for ACP agents." → "Bridge GOAT's MCP endpoint to stdio for ACP agents."
- Add packages/provider-opencode/src/server/v2/adapter.ts:3310 "Could not add T3 Code's MCP server to OpenCode." → "Could not add GOAT's MCP server to OpenCode."
- Gate: rg -n "T3 Code('s)? MCP" apps/_/src packages/_/src -g '!*.live.test.ts' must be empty.
