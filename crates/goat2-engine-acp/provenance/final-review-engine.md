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

## Final review 7 (head 3a2bd238f2)

Each high and medium finding has a regression test that failed on the unfixed code.

| Finding | GOAT 2 | v1 source | Kind |
|---|---|---|---|
| 2.1 | src/process.rs (without_host_identity), src/probe_support.rs (is_host_identity): GOAT2_HOST_TOKEN | lane B goat2-engine-codex/src/process.rs:65 (GOAT 2; v1 has no such token) | ported from lane B; tests process::tests::the_host_ui_token_is_not_inherited_but_other_host_settings_are, catalog_tests::a_base_environment_holding_the_host_token_does_not_pass_it_to_the_agent |
| 2.2 | src/policy.rs (PathSet, known_changed_paths) | packages/provider-acp/src/server/clientPolicy.ts:122-128,139-209 | adapted (a set, stops past 256 paths); test many_distinct_locations_are_unknown_quickly |
| 2.3 | src/wire.rs (find_model_config_option, parse_modes) | packages/provider-acp/src/server/runtimeModel.ts:428-435,478-517 | ported-to-Rust |
| 2.4 | goat2-acp-mcp-bridge src/lib.rs: unused HttpRelay::send and initialize removed | - | removed (no caller) |
| 2.5 | src/stderr.rs (home_directories, account_home) | packages/provider-acp/src/server/stderr.ts:22 (os.homedir()) | ported-to-Rust (getpwuid_r) |
| 3.1 | src/subagents.rs (root_tool after the turn keeps no tool) | packages/provider-acp/src/server/adapter.ts:3741-3775 | ported-to-Rust; test a_report_between_turns_is_not_a_tool_of_the_next_turn |
| 3.2 | src/subagents.rs (apply refuses a terminal change outside the owning turn) | adapter.ts:4664-4666 (updateCarryoverSubagentStatus), 1800-1813 | ported-to-Rust; test a_late_report_does_not_rewrite_an_interrupted_subagent |
| 3.3 | src/mcp_over_acp.rs (dispose stops calls, refuses later connects and calls) | adapter.ts:5547; mcpOverAcpBridge.ts:121-123 | adapted; test dispose_stops_calls_in_flight_and_later_connects |
| 3.5 | src/subagents.rs (prune, launch ids per turn) | adapter.ts per-turn context.subagents and carryover | adapted |
| 4.1 | src/agents/grok_tools.rs (background_tool_mutations), src/flavor.rs (BackgroundMutation.append_output: Arc<str>) | provider-grok/xaiAcpExtension.ts:602-657 | adapted (one summary, one ended mutation per task, 64 per message); test repeated_monitor_ends_stay_bounded |
| 4.2 | src/flavor.rs (PromptComplete/PromptFailed.session_id), src/engine.rs, src/agents/grok.rs | provider-grok/xaiAcpExtension.ts:19-24,1381-1390 | ported-to-Rust; tests a_prompt_completion_for_another_session_does_not_settle_the_turn, prompt_completions_carry_their_session_and_need_a_string_prompt_id |
| 4.3 | src/agents/xai_requests.rs | provider-grok/xaiAcpExtension.ts:875-880; provider-grok/adapter.ts:214 | ported-to-Rust |
| 4.4 | src/agents/grok.rs (finish_launch writes the referrer last) | provider-grok/acpSupport.ts:155-159 | ported-to-Rust |
| 5a.1 | src/agents/antigravity.rs (initialize_refusal redacts the home) | apps/server/src/provider/Drivers/AntigravityDriver.ts:408-427 | adapted (home as ~); test the_runtime_refusal_hides_the_home_directory |
| 5a.2 | src/agents/antigravity.rs (release_runtime, MAX_TRACKED_SESSIONS) | AntigravityAdapterV2.ts:168-172 | adapted |
| 5a.3 | src/agents/antigravity_files.rs (lexically_resolved) | AntigravityClientFiles.ts:45 | ported-to-Rust |
| 5a.6 | src/agents/antigravity.rs, src/flavor.rs (Debug of AntigravityLaunch, LaunchCommand, AgentEnv without values) | - | written new |
| 5a.7 | src/agents/antigravity_auth.rs (with_linux_ca_bundle) | apps/server/src/provider/antigravityAuthSupport.ts:401-420 | ported-to-Rust |
| 5b.1 | src/agents/fx.rs (fx_subagent_outcome) | packages/provider-fx/src/server/adapter.ts:114 | ported-to-Rust (a lone high surrogate escape is dropped); test subagent_calls_become_child_work |
| 6a.1 | src/registry/install.rs (extraction_error_text, lock_timeout_message) | AcpRegistrySupport.ts:1173-1176,1411-1416 | adapted (paths relative to the destination, home as ~); test an_extraction_error_does_not_name_the_destination |
| 6a.2 | src/registry/install.rs (run_command in its own process group, GroupGuard) | @effect/platform-node-shared 4.1.2 NodeChildProcessSpawner.js:372,384,497; AcpRegistrySupport.ts:739 | adapted (Unix; Windows kills the direct child); test dropping_a_command_kills_its_process_group |
| 6b.1 | src/registry/catalog.rs (local agent id is the executable name) | packages/provider-acp-registry/src/server/adapter.ts:213-215 | adapted; test a_local_agent_id_has_no_path |
| 6b.2 | src/registry/catalog.rs (override error) | AcpRegistrySupport.ts:1769 | adapted (home as ~) |
| 6b.3, 6b.4, 6b.5 | src/registry/cache.rs (file I/O outside the state lock, fresh check before the fetch permit, request and body timeouts) | registryIndexCache.ts:116-128,176-205; AcpRegistrySupport.ts:653-690 | ported-to-Rust; test a_fresh_search_does_not_wait_for_a_running_fetch |
| 6b.6 | src/registry/catalog.rs (uninstall validates before the permit) | AcpRegistrySupport.ts:1876-1879 | adapted |
| 7.1 | src/registry/schema.rs (secret_max_len), src/registry/contracts.rs | acpRegistry.ts:243-249 | adapted (length only) |
| 7.2 | src/registry/agents/copilot.rs (release clears the runtime) | copilotAcp.ts:139-149 | ported-to-Rust |
| 7.4, 7.5 | src/registry/agents/devin.rs, droid.rs, omp.rs, opencode.rs | devinAcp.ts:34; droidAcp.ts:35; ompAcp.ts:33; opencodeAcp.ts:38 | ported-to-Rust |
| 8a.1 | src/probe_registry.rs (discover_model_options), src/engine.rs (AcpSession::set_config_option) | packages/provider-acp-registry/src/server/modelDiscovery.ts:33-91; AcpSessionRuntime.ts:1023-1075 | ported-to-Rust; tests model_discovery_restores_an_original_named_default, model_discovery_resends_the_original_after_an_unseen_switch |
| 8a.2 | src/probe.rs (ProbeConfig.sensitive_env), src/probe_registry.rs | minimaxCodeUsageEnrichment.ts:7-35 | ported-to-Rust |
| 8a.3 | src/engine.rs (with_advertisement_graces), tests/probe.rs | probe.ts:500-516,535-569 | written new (test seam) |
| 8b.3 | src/bin/acp_mock_agent.rs (chosen Grok model, GOAT_ACP_MODEL_VALUES, GOAT_ACP_SET_CONFIG_BARE) | apps/server/scripts/acp-mock-agent.ts:451-461 | ported-to-Rust; the two knobs are GOAT 2 additions |
