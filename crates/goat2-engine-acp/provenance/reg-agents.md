# Registry agent session behavior

Reference: GOAT v1 commit `916b5ccc1b2` (`~/Developer/goat`). One row per GOAT 2 file.

| GOAT 2 path | v1 path@916b5ccc1b2 (lines) | Lift |
| --- | --- | --- |
| `crates/goat2-engine-acp/src/registry/mod.rs` (`RegistryAgentFlavor`) | `packages/provider-acp-registry/src/server/adapter.ts` (183-188 authMethodId/customModels, 206-349 per-agent flavor, 270 Copilot routing, 243 Kimi watch, 274-282 Copilot capabilities, 299-305 forms, 309-316 Claude, 323-349 Devin/Copilot); `packages/provider-acp/src/server/adapter.ts` (5985-6018 model writes, `alwaysSetModel`) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/mod.rs` | `packages/provider-acp-registry/src/server/adapter.ts` (213-267 agent detection); `mcpTransport.ts` (1-27); `settings.ts` (13-25 `isMiniMaxCode`) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/devin.rs` | `packages/provider-acp-registry/src/server/devinAcp.ts` (1-63); `adapter.ts` (323-333 client capability `_meta`) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/copilot.rs` | `packages/provider-acp-registry/src/server/copilotAcp.ts` (1-326, whole file); `copilotAcp.test.ts` (cases) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/claude.rs` | `packages/provider-acp-registry/src/server/claudeAcp.ts` (1-119); `sessionEnvironmentKey.ts` (7-22); `packages/effect-acp/src/_internal/normalizeV2Client.ts` (221-231 `raw` is the update) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/droid.rs` | `packages/provider-acp-registry/src/server/droidAcp.ts` (1-84) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/omp.rs` | `packages/provider-acp-registry/src/server/ompAcp.ts` (1-66) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/opencode.rs` | `packages/provider-acp-registry/src/server/opencodeAcp.ts` (1-136); `opencodeAcp.test.ts` (cases) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/forms.rs` | `droidAcp.ts` (66-77), `opencodeAcp.ts` (40-47) attachment suffix; `packages/contracts/src/baseSchemas.ts` (14-29 `TrimmedNonEmptyString` as `Schema.is` sees it) | ported-to-Rust |
| `crates/goat2-engine-acp/src/registry/agents/kimi.rs` | `packages/provider-acp-registry/src/server/kimiAcp.ts` (1-312, whole file); `kimiAcp.test.ts` (cases) | ported-to-Rust (adapted: one process environment instead of recorded vs runtime) |
| `crates/goat2-engine-acp/src/registry/agents/vibe.rs` | `packages/provider-acp-registry/src/server/adapter.ts` (100-129) | adapted (retry becomes a warning notice) |
| `crates/goat2-engine-acp/src/subagents.rs` | `packages/provider-acp/src/server/adapter.ts` (465-468 gate, 1646-1669, 1790-2070 `emitSubagent`, 2335-2404 `followNativeChild`, 2519-2629 `emitTool`, 3741-3775 and 3817-3879 child routing, 4675-4725 `finishSubagentFromNotice`, 4833-4851 carryover); `acpSubagentStatus.ts` (1-17) | adapted (no child thread: progress events plus a `subagent` item) |
| `crates/goat2-engine-acp/src/flavor.rs` | `packages/provider-acp/src/server/adapterFlavor.ts` (72-98 `finishSubagent`/`reportForegroundWork`, 142-156 `watchPromptOutcome`, 172-185, 204-206, 266-268, 309-319, 380, 394); `adapter.ts` (5936-6016), `AcpSessionRuntime.ts` (1063-1068 custom models) | ported-to-Rust |
| `crates/goat2-engine-acp/src/engine.rs` | `packages/provider-acp/src/server/adapter.ts` (1018 `clientCapabilitiesMeta`, 3817-3879 other sessions, 5367-5388 native forms and `cognition.ai/allowOther`, 5431-5478 extension callbacks, 6812-6830 outcome watch, 6982-6989 restart after prompt error); `elicitationForm.ts` (196-220 `withOptionalChoices`) | adapted |
| `crates/goat2-engine-acp/src/items.rs` (`take_ordinal`) | `packages/provider-acp/src/server/adapter.ts` (1841-1842 subagent item ordinal) | adapted |
| `crates/goat2-engine-acp/src/bin/acp_mock_agent.rs` (`GOAT_ACP_SCRIPT`, `GOAT_ACP_DEVIN_PLAN_BYPASS`) | `apps/server/scripts/acp-mock-agent.ts` (scenario style); traffic from `copilotAcp.test.ts`, `kimiAcp.integration.test.ts`, `opencodeAcp.test.ts`, `devinAcp.ts` | adapted (GOAT 2 scripted steps) |
| `crates/goat2-engine-acp/tests/registry_agents.rs` | `copilotAcp.test.ts`, `kimiAcp.integration.test.ts`, `opencodeAcp.test.ts`, `devinAcp.ts`, `droidAcp.ts`, `ompAcp.ts`, `adapter.ts` (100-129, 213-349) | adapted |
| `crates/goat2-engine-acp/tests/engine.rs` (Devin plan bypass, Copilot model resend) | `devinAcp.ts` (58-63); `adapter.ts` (334-361) | adapted |

## Not carried, with reasons

- Devin `clientTerminals` with `shellCommands` (`adapter.ts:451-459`, `packages/provider-acp/src/server/clientTerminals.ts`): the GOAT 2 driver serves no `terminal/*` requests yet, so Devin is not offered client terminals.
- Claude `followAgentWorkState` turn settlement on native idle and v1's ACP v2 child sessions: v1 enables them only on negotiated ACP v2; the GOAT 2 driver speaks ACP v1 and the `agent-client-protocol` crate refuses a v2 peer. The extractors and the tracker path are ported and unit tested; integration is inactive until the driver negotiates v2.
- Post-settle continuation and deferred finalize (Copilot `enablePostSettleContinuation`, `requireForegroundWakeTransition`; Hermes and local `agy` `wakeOnDetachedRequest`, `replyEndsWithUsageUpdate`): the GOAT 2 engine has no wake/continuation runs. Background subagents carry over and finish into their own turn instead.
- `unsetOptionDefaults`, `onAvailableCommandsUpdate`, `onSessionConfigurationUpdate`, `onUrlElicitation`, `withRuntimeStartup` (`adapter.ts:372-438`): runtime-coordinator publishing (host scope).
- `compactViaAdvertisedCommand`, glm `reportsPerTurnPromptUsage`, Mistral Vibe `promptFailure` class (`usage_limit` for -31001): no compaction call, usage projection or failure class in the GOAT 2 engine API; Vibe failures keep the agent's message.
- Driver/probe scope: `learnedModels.ts`, `learnedModelOptions.ts`, `discoveredModels.ts`, `modelDiscovery.ts`, `liveModelConfiguration.ts`, `auth.ts`, `authenticationState.ts`, `minimaxCodeAccountQuota.ts`, `minimaxCodeUsageEnrichment.ts`, `deepSeekProbeHistory.ts`. MiniMax Code and DeepSeek have no session-time behavior beyond the generic registry agent in v1.
