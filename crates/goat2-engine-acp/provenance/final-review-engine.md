# P2-B final review, engine slice: what each fix lifted

GOAT v1 at goat-si/goat origin/dev `916b5ccc1b2`. Findings are the final review's numbers.

| Finding | GOAT 2 | v1 source | Kind |
|---|---|---|---|
| 1 | src/flavor.rs (permission_option_id), src/agents/grok.rs (permission_option_id), src/engine.rs (answer, auto-approve, deny) | packages/provider-acp/src/server/permissionOptions.ts:4-24; packages/provider-grok/src/server/acpSupport.ts:196-211 | adapted (Grok's session choice is its one session-scoped option, wherever listed) |
| 2 | src/policy.rs (merge_changed_paths, auto_accept_policy_request, UnreadToolCalls, unread_tool_call_update), src/items.rs (ToolState.changed_paths, tracked_call, content chunks), src/engine.rs (on_permission, on_session_update) | packages/provider-acp/src/server/autoAcceptEdits.ts:21-182; clientPolicy.ts:98-107; runtimeModel.ts:56-61,929-983; adapter.ts:4016-4023,5148-5175 | ported-to-Rust (unreadable = a tool update without a tool call id, or no readable sessionUpdate) |
| 4, 21 | src/stderr.rs (StderrTail, read_bounded), src/process.rs (tail per chunk, hook per line) | packages/provider-acp/src/server/stderr.ts:11-13,28-34; AcpSessionRuntime.ts:835 | adapted (cleaned per line before the tail is cut; runs at a cut and a value after a bare key redacted) |
| 5 | src/engine.rs (read_frame, MAX_FRAME_CHARS) | packages/effect-acp/src/_internal/strictParser.ts:14-45 | ported-to-Rust (counts Unicode scalar values, v1 UTF-16 units) |
| 7 | src/engine.rs (SigninPending, signin_links) | packages/provider-acp-registry/src/server/adapter.ts:425-436 (onUrlElicitation to the runtime coordinator); probe.ts:461-487 | adapted (no coordinator: the link goes to the host on a handle that restarts the agent on the next turn) |
| 8 | src/subagents.rs (child_update) | packages/provider-acp/src/server/adapter.ts:2298-2333 | ported-to-Rust |
| 9 | already fixed: src/engine.rs State.model_selection compares the whole selection | packages/provider-grok/src/server/acpSupport.ts:299-324 | test only (tests/grok.rs effort_change_on_the_same_model_is_written) |
| 10 | src/engine.rs (prompt_blocks returns whether the preamble went out) | packages/provider-acp/src/server/acpAppContext.ts:63-64 | ported-to-Rust |
| 11 | src/engine.rs (handshake, auth after -32000) | packages/provider-acp/src/server/AcpSessionRuntime.ts:1514-1527 | ported-to-Rust |
| 15 | src/elicitation.rs (number_answer) | packages/provider-acp/src/server/elicitationForm.ts:153-161 | adapted (64-bit integers exact; v1 JS numbers round above 2^53) |
| 16 | src/items.rs (line_counts) | packages/provider-acp/src/server/runtimeModel.ts:385-394 keeps the diff text | written new (ordered LCS counts; omitted past 4,000,000 line pairs) |
| 17 | src/mcp_over_acp.rs (dispose) | packages/provider-acp/src/server/mcpOverAcpBridge.ts:278-283 | ported-to-Rust (plus one 5 s deadline for the whole dispose) |
| 24 | already fixed: src/agents/grok_notifications.rs keeps agent_result of turn_completed | packages/provider-grok/src/server/xaiAcpExtension.ts:57-75,1281-1298 | test only (src/agents/grok.rs turn_completed_requires_root_identity) |
| tests | src/bin/acp_mock_agent.rs (GOAT_ACP_CRASH_STDERR_PARTIAL, GOAT_ACP_STDERR_HOLDER, GOAT_ACP_FLOOD_STDOUT, GOAT_ACP_URL_ELICITATION_ONCE_PATH) | apps/server/scripts/acp-mock-agent.ts (scenario style) | written new (GOAT 2 knobs) |

