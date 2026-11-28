# Antigravity and fx (v1 916b5ccc1b2)

Slice `antigravity-fx` of lane P2-B. One row per GOAT 2 file; line ranges are v1 at `916b5ccc1b2`.

| GOAT 2 path | v1 path@916b5ccc1b2 (lines) | Method |
| --- | --- | --- |
| src/flavor.rs (`ConfigWrite`, `ModelWrite::ConfigOptions`) | packages/provider-acp/src/server/AcpSessionRuntime.ts (1023-1075, 1363-1420); adapter.ts (5961-6113) | ported-to-Rust: setConfigOption validation/skip/resend and the option loop's skips |
| src/flavor.rs (`ModeWrite`, `ModeContext`, `runtime_set_mode`, `mode_write`) | packages/provider-acp/src/server/AcpSessionRuntime.ts (2068-2098); adapter.ts (6047-6116) | ported-to-Rust |
| src/flavor.rs (`StdoutLine::Fail`, `StderrLine`, `stderr_line`) | packages/provider-acp/src/server/AcpSessionRuntime.ts options `transformStdout`, `onStderr` | adapted: a transform/stderr failure ends the connection or fails the turn |
| src/flavor.rs (`AuthFailure`, `auth_failure`) | packages/provider-acp/src/server/adapterFlavor.ts (157); adapter.ts (8419) | adapted (`requiresSignIn` -> sign-in request) |
| src/flavor.rs (`permission_request_action`, `elicitation_questions`) | packages/provider-acp/src/server/adapterFlavor.ts (204, 253); adapter.ts (5128-5147, 5367) | ported-to-Rust |
| src/flavor.rs (`read_text_file`, `ClientRead`, `prompt_sent`) | packages/provider-acp/src/server/adapter.ts (5081-5096); AntigravityAdapterV2.ts (176-198) | adapted |
| src/flavor.rs (`prompt_attachment_blocks`, `PromptAttachment`) | packages/provider-acp/src/server/adapterFlavor.ts `buildPrompt` | adapted (text block stays with the driver) |
| src/flavor.rs (`subagent_update`, `SubagentToolUpdate`) | packages/provider-acp/src/server/adapterFlavor.ts `extractSubagentUpdate`, `AcpAdapterV2SubagentUpdate` | adapted (progress event only) |
| src/flavor.rs (`initialize_refusal`) | packages/provider-acp/src/server/adapterFlavor.ts (159) `checksVersionAtHandshake`; apps/server/src/provider/Drivers/AntigravityDriver.ts (346-371, 408-427) | adapted (the driver's handshake check as a flavor hook) |
| src/engine.rs (routing for the hooks above, `write_config`, `fail_process`, selection change detection, first mode write) | packages/provider-acp/src/server/adapter.ts (5081-5200, 5961-6204); AcpSessionRuntime.ts (1363-1420, 2068-2098) | ported-to-Rust |
| src/engine.rs (re-authenticate with the configured method after -32000) | packages/provider-acp/src/server/AcpSessionRuntime.ts (1510-1555) | ported-to-Rust |
| src/engine.rs (stderr hook kept on the live state; transport failure in handshake errors) | GOAT 2 fix | written new: the hook pointed at state replaced after spawn |
| src/agents/antigravity.rs | apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts (67-84, 150-359); apps/server/src/provider/acp/AntigravityAcpSupport.ts (66-145, 147-187, 189-263, 265-354); apps/server/src/provider/Drivers/AntigravityDriver.ts (397-461, 666-672); packages/contracts/src/model.ts (136) | ported-to-Rust |
| src/agents/antigravity_auth.rs | apps/server/src/provider/antigravityAuthSupport.ts (30-248, 398-430, 471-495, 513-742); packages/contracts/src/settings.ts (730-738) | ported-to-Rust (profile prep: directories and settings.json only) |
| src/agents/antigravity_protocol.rs | apps/server/src/provider/acp/AntigravityProtocol.ts (43-46, 128-288, 290-549, 620-688, 738-790); AntigravityAcpSupport.ts (213-248) | ported-to-Rust; command fields adapted to per-update JSON; text bounds count chars (v1 UTF-16 units) |
| src/agents/antigravity_goat_tools.rs | packages/shared/src/goatMcpToolPresentation.ts (28-871), goatMcpLifecycleToolPresentation.ts, goatMcpPullRequestToolPresentation.ts | verbatim (the key list of `GOAT_MCP_TOOL_NAMES`) |
| src/agents/antigravity_prompt.rs | apps/server/src/provider/acp/AntigravityAcpSupport.ts (92-98, 356-597); packages/contracts/src/chatAttachment.ts (15-17) | ported-to-Rust (no pasted-text attachments in GOAT 2) |
| src/agents/antigravity_files.rs | apps/server/src/provider/acp/AntigravityClientFiles.ts (15-133) | ported-to-Rust (read only; v1 never advertises writes) |
| src/agents/antigravity_subagent.rs | apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts (113-141); apps/server/src/provider/acp/AntigravityProtocol.ts (694-736); AntigravitySwarmProtocol.ts (1-120, 238-255); AntigravityChildWork.ts (44-83); AntigravitySwarmWork.ts (10-64) | ported-to-Rust |
| src/agents/fx.rs | packages/provider-fx/src/server/acpSupport.ts (25-238); adapter.ts (51-152, 180-221); src/settings.ts; driver.ts (108-112) | ported-to-Rust |
| src/agents/fx_skills.rs | packages/provider-fx/src/server/skills.ts (1-373) | ported-to-Rust |
| src/agents/mod.rs | - | module list; tests use `Fx::default()` |
| src/bin/mock_flavors/antigravity_fx.rs | apps/server/scripts/acp-mock-agent.ts (45, 119-125, 158-224, 392-401, 537-557, 628-652, 820-844); acpMockAntigravityThoughtLevel.ts; acpMockHarnessFailure.ts | ported-to-Rust (Antigravity profile); fx profile and the GOAT 2 scenarios marked in the file are new |
| src/bin/acp_mock_agent.rs (two dispatch lines) | - | written new |
| tests/antigravity.rs | apps/server/src/orchestration-v2/Adapters/AntigravityModePolicy.test.ts, AntigravitySteering.test.ts; apps/server/src/provider/acp/AntigravityAcpSupport.test.ts, AntigravityProtocol.test.ts, AntigravityClientFiles.test.ts (behaviours, not code) | written new against the fake agent |
| tests/fx.rs | packages/provider-fx/src/server/acpSupport.ts, adapter.ts (behaviours) | written new against the fake agent |

## Not carried (v1 has it, GOAT 2 does not yet)

Antigravity, needing adapter machinery the GOAT 2 driver does not have: background work that outlives
the prompt (`toolOutlivesPrompt`, `postSettleCommandHold`, `enablePostSettleContinuation`,
`deferFinalizeForBackgroundWork`, `wakeOnDetachedRequest`, `replyEndsWithUsageUpdate`,
`preserveRuntimeOnSettledInterrupt`), `promptInactivityTimeout`, `compactViaAdvertisedCommand`,
per-turn Gemini usage, the installer's compatibility advisory in the handshake refusal, the
profile-directory readers (`AntigravityTurnOutcome.ts`, `AntigravityExecutedModel.ts`,
`AntigravityChildWork.ts` transcripts, `AntigravitySubagentTranscript.ts`, `AntigravitySessionFiles.ts`,
`AntigravitySwarmWork.ts` disk members), swarm tool presentation titles
(`normalizeAntigravitySwarmToolPresentation`), subagent rows as `TurnItemBody::Subagent`, edit patch
location (`AntigravityEditLocation.ts`), the picked `_t3/session-mode` under the runtime-mode
ceiling, the browser-suppression preflight and user skill/rule linking (Node helper), `agy acp --login`
code login (helpers `parse_authorization_url(Code)` and `login_response` are ported), installation
resolution and updates.

fx: subagent calls emit `EngineEvent::SubagentUpdate` but no `TurnItemBody::Subagent` item; replay
fixtures (`record-fx-acp-replay-fixture.ts`) belong to P2-D; probes (`status.ts`) belong to the probe slice.

