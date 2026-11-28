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

## Final review 6 (head 990566f)

| Finding | GOAT 2 | v1 source | Kind |
|---|---|---|---|
| B1 | src/probe_support.rs (collect_command, GroupGuard), src/agents/grok_skills.rs (discover_skills) | packages/provider-core/src/server/snapshotProbe.ts:159,182-205 (spawnAndCollect, 8 MiB caps); packages/provider-grok/src/server/skills.ts:97-109 | adapted (the process group is killed and reaped as soon as a stream passes its cap) |
| B2 | src/agents/grok_auth.rs (resolve_key, resolve_for_spec, apply_to_merged), src/flavor.rs (finish_launch), src/engine.rs (launch_for), src/probe.rs (effective_command) | packages/provider-grok/src/server/auth.ts:57-64 (applyStoredGrokApiKey); adapter.ts:400-416; driver.ts:354-358; acpSupport.ts:164-168 | ported-to-Rust (applied to the merged environment after the launch overrides) |
| C1 | src/registry/archive.rs (ArchiveLimits, MAX_EXTRACTED_BYTES, MAX_ARCHIVE_ENTRIES, extract_within), src/registry/install.rs (install_locked) | packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:74,1382-1418 (download cap only) | written new (4 GiB and 200000 entries, charged before each entry is written; a failed extraction is emptied) |
| C2 | src/registry/install.rs (RunOptions.label, read_clean_tail, discover_npm_global_package, discover_uv_global_package) | packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:717-800,917-986; packages/provider-acp/src/server/stderr.ts (sanitizeAcpStderrExcerpt) | adapted (manager named npm/uv; stderr cleaned per line before the 1000-character tail; home prefixes as ~) |
| D1 | src/probe_grok.rs (acp_initialize_only), src/engine.rs (read_frame) | packages/effect-acp/src/_internal/strictParser.ts:18-30 | ported-to-Rust |
| D2 | src/probe_support.rs (redact_home, probe_homes, spawn_failure_message_with_homes), src/probe_fx.rs, src/probe_grok.rs | packages/provider-core/src/server/spawnFailure.ts:130-144 | adapted (home prefix shown as ~) |
| tests | src/bin/acp_mock_agent.rs (GOAT_ACP_ENV_LOG_PATH, GOAT_ACP_ENV_LOG_NAMES) | apps/server/scripts/acp-mock-agent.ts (scenario style) | written new (GOAT 2 knobs) |
