# Provider probes (P2-B slice "probes", v1 916b5ccc1b2)

| GOAT 2 path | v1 path@916b5ccc1b2 (lines) | treatment |
| --- | --- | --- |
| `src/probe.rs` (`ProbeConfig`, `probe_provider` dispatch, `open_probe_within`, `AcpProbeFailure.timed_out` / `initialize_raw`, `probe_timeout_message`) | packages/provider-acp-registry/src/server/probe.ts:72-77, 389-606; driver kinds as in apps/web/src/components/settings/providerDriverMeta.ts | ported-to-Rust; `ProbeConfig` carries what v1 read from each driver's settings |
| `src/probe.rs` `probe_fingerprint` | packages/provider-acp-registry/src/server/probeFingerprint.ts:9-20 | ported-to-Rust (key order is serde's; digest bytes not promised equal) |
| `src/engine.rs` `EngineFactory::probe` for `AcpEngineFactory`, `probe_config` field | packages/provider-core/src/server/managedProvider.ts check per driver (status.ts of each provider) | adapted: one async call returning the contract's `ProviderProbeResult` |
| `src/engine.rs` `config_options_from_update` | packages/provider-acp-registry/src/server/probe.ts:545-547 (an update replaces setup options) | adapted: fixes the race where the setup response overwrote an update handled first |
| `src/probe_support.rs` timeouts, `resolve_provider_probe_timeout` | packages/provider-core/src/server/snapshotProbe.ts:47-61 | ported-to-Rust |
| `src/probe_support.rs` `provider_probe_environment` | packages/provider-core/src/server/probeEnvironment.ts:1-13 | verbatim values |
| `src/probe_support.rs` `is_missing_mise_tool_result`, `is_missing_probe_tool_result`, `spawn_and_collect`, `parse_cli_version_result`, `parse_generic_cli_version` | packages/provider-core/src/server/snapshotProbe.ts:138-229 | ported-to-Rust; look-around of the version pattern checked by hand; Windows "not recognized" detection not ported |
| `src/probe_support.rs` `classify_spawn_failure`, `executable_exists`, `spawn_failure_message`, `safe_process_cwd` | packages/provider-core/src/server/spawnFailure.ts:7-152 | ported-to-Rust (error codes from io::Error kinds) |
| `src/probe_support.rs` `with_login_shell_path_note` | packages/shared/src/cliPath.ts:10-13, 58-73 | verbatim message |
| `src/probe_support.rs` `create_model_capabilities`, `read_custom_model_entries`, `provider_models_from_settings` | packages/shared/src/model.ts:32-38, 427-474; packages/provider-core/src/server/snapshotProbe.ts:231-265 | ported-to-Rust |
| `src/probe_support.rs` `bounded_text`, `bounded_opaque_value` | packages/provider-acp-registry/src/server/probeHelpers.ts:9-16 | ported-to-Rust (char counts, v1 counts UTF-16 units) |
| `src/probe_models.rs` `acp_provider_option_descriptors`, `is_thought_level_option`, `flatten_select_choices` | packages/provider-acp/src/server/sessionConfig.ts:6-150 | ported-to-Rust |
| `src/probe_models.rs` `advertised_reasoning_effort`, `normalize_models`, `normalize_live_configuration`, `live_catalog_key`, `advertises_model_catalog` | packages/provider-acp-registry/src/server/probe.ts:66-142, 209-299 | ported-to-Rust |
| `src/probe_models.rs` `models_from_discovery` | packages/provider-acp-registry/src/server/discoveredModels.ts:7-75 | ported-to-Rust |
| `src/probe_models.rs` `apply_live_configuration` | packages/provider-acp-registry/src/server/liveModelConfiguration.ts:6-69 | ported-to-Rust (on `ProviderProbeResult`; "enabled" read from `status != disabled`) |
| `src/probe_models.rs` `current_model_options`, `with_learned_model_options` | packages/provider-acp-registry/src/server/learnedModelOptions.ts:205-246 | ported-to-Rust |
| `src/probe_models.rs` `probe_ttl_ms`, `is_cache_valid` | packages/provider-acp-registry/src/server/enrichmentCache.ts:6-37 | ported-to-Rust |
| `src/probe_registry.rs` `snapshot_readiness` | packages/provider-acp-registry/src/server/snapshotReadiness.ts:5-60 | verbatim messages |
| `src/probe_registry.rs` `normalize_auth_methods`, `shell_display_token`, `normalize_web_url` | packages/provider-acp-registry/src/server/probe.ts:144-202; shellDisplayToken.ts; probeHelpers.ts:18-22 | ported-to-Rust |
| `src/probe_registry.rs` `normalize_registry_commands` | packages/provider-acp-registry/src/server/probe.ts:301-335 | ported-to-Rust |
| `src/probe_registry.rs` `classify_probe_failure` | packages/provider-acp-registry/src/server/probeHelpers.ts:24-52 | adapted: missing-tool output read from the failure message (it carries the stderr tail) |
| `src/probe_registry.rs` `bounded_agent_version` | packages/provider-acp-registry/src/server/agentVersion.ts | ported-to-Rust |
| `src/probe_registry.rs` `isolate_deepseek_probe_history`, `ProbeTempDir` | packages/provider-acp-registry/src/server/deepSeekProbeHistory.ts:10-49 | ported-to-Rust |
| `src/probe_registry.rs` `discover_model_options` | packages/provider-acp-registry/src/server/modelDiscovery.ts:13-91 | adapted: the requested list comes from `ProbeConfig.discover_models` instead of the `onProbed` callback |
| `src/probe_registry.rs` `initial_registry_snapshot`, `checked_registry_snapshot`, `check_registry_provider_status` | packages/provider-acp-registry/src/server/driverSnapshots.ts:36-277; probe.ts:337-368, 389-606 | ported-to-Rust; inspection reduced to "command found / not found" (resolution belongs to the registry slice) |
| `src/probe_grok.rs` | packages/provider-grok/src/server/status.ts:57-623; probeEnvironment.ts; auth.ts:20; acpSupport.ts:133-144, 194, 248-260; packages/provider-acp/src/server/runtimeModel.ts:1234-1240 | ported-to-Rust; initialize-only ACP client written for the probe |
| `src/probe_fx.rs` | packages/provider-fx/src/server/status.ts:38-261; acpSupport.ts:25-57 | ported-to-Rust |
| `src/probe_antigravity.rs` | apps/server/src/provider/AntigravityProvider.ts:49-58, 182-196, 388-475; Drivers/AntigravityDriver.ts:661-726; antigravityAuthSupport.ts:112-144; AntigravityInstallation.ts:272-308 | ported-to-Rust; managed-release lookup and harness-sibling checks not ported |
| `src/probe_minimax.rs` | packages/provider-acp-registry/src/server/minimaxCodeAccountQuota.ts:13-306; minimaxCodeUsageEnrichment.ts:7-59 | ported-to-Rust with an HTTP seam (`QuotaHttp`) |
| `src/bin/acp_mock_agent.rs` probe scenarios (`GOAT_ACP_EXIT_AT_START`, `_ARGV_LOG_PATH`, `_INITIALIZE_META`, `_AUTH_METHODS`, `_AUTH_REQUIRED`, `_LOGOUT`, `_SESSION_MODELS`, `_NO_MODEL_OPTION`, `_THOUGHT_LEVEL`, `_LATE_MODELS`, `_MOCK_CLI*`) | apps/server/scripts/acp-mock-agent.ts (scenario style) | GOAT 2 additions |
| `tests/probe_status.rs` | the v1 rules cited in each test's doc comment | written new for GOAT 2 (v1's own status tests were not ported) |

Not ported, and why:
- `probeManagement.ts` (session list/delete, provider list/set/disable, logout): management operations, not part of `probe()`.
- `learnedModels.ts`, `learnedModelOptions.ts` store, `authenticationState.ts`, `enrichmentCache.ts` cache state: host-side state kept across probes and sessions; only their pure functions are here.
- Grok skills discovery and slash commands, Antigravity workspace snapshots, version advisories: no contract field.
- URL sign-in elicitations during a probe (`authAction`, probe.ts:461-489): `ServerProviderAuth` has no action field; the URL is kept in `RegistryProbeError.auth_url`.
