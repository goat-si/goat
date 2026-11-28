# Grok ACP (v1 916b5ccc1b2)

Every GOAT 2 file of the Grok slice, with the v1 source it was lifted from. v1 paths are relative to
`goat-si/goat` at `916b5ccc1b2`; `provider-grok` means `packages/provider-grok/src/server` and
`provider-acp` means `packages/provider-acp/src/server`.

| GOAT 2 path | v1 path@916b5ccc1b2 (lines) | Method |
| --- | --- | --- |
| src/agents/grok.rs (capabilities, launch, auth policy, initialize/cancel meta, restart/preserve/defer flags, image prompts, permission disposition, approval options, prompt meta, hook wiring) | provider-grok/adapter.ts:92-127,232-243,347-475; provider-grok/acpSupport.ts:30-33,125-245 | ported-to-Rust |
| src/agents/grok.rs (prompt completion: `prompt_complete`, `turn_completed`, `rate_limit` / `error` failures) | provider-grok/xaiAcpExtension.ts:16-24,57-76,1236-1301,1429-1482; provider-grok/adapter.ts:433-446 | ported-to-Rust (matched by session and prompt id as v1, xaiAcpExtension.ts:1381-1390; a session has one prompt pending, which is v1 exactly-one rule for a completion without a prompt id; a non-string `promptId` is dropped as v1 decode does) |
| src/agents/grok_tools.rs | provider-grok/xaiAcpExtension.ts:98-379,526-859; provider-grok/xaiMcpToolCall.ts:1-57; provider-grok/commandTitle.ts:1-7 | ported-to-Rust (JS regex lookaheads rewritten by hand; UTF-16 title cut kept; final review 7: an injected message ends at most 64 monitors, one per task, sharing one summary, where v1 copies the message per match) |
| src/agents/grok_notifications.rs | provider-grok/xaiAcpExtension.ts:28-87,382-524 | ported-to-Rust (Effect schema decode checked field by field; v1 wake `report` dropped, no consumer) |
| src/agents/grok_plan.rs | provider-grok/xaiAcpExtension.ts:957-1090; provider-grok/adapter.ts:451-461 | ported-to-Rust |
| src/agents/grok_model.rs | provider-grok/adapter.ts:250-345; provider-grok/acpSupport.ts:247-325; provider-grok/status.ts:134-206 (`grokReasoningOptionsFromModel` values only) | ported-to-Rust |
| src/agents/grok_skills.rs | provider-grok/skills.ts:1-146; provider-grok/probeEnvironment.ts:1-5; packages/provider-core/src/server/probeEnvironment.ts:2-13; packages/provider-core/src/server/snapshotProbe.ts:50-61; packages/shared/src/composerInlineTokens.ts:26-30; provider-grok/adapter.ts:365-383 | ported-to-Rust (skill pattern lookaheads rewritten by hand) |
| src/agents/grok_auth.rs | provider-grok/auth.ts:19-64; provider-grok/acpSupport.ts:30-33,164-168; provider-grok/adapter.ts:134-135,400-416 | ported-to-Rust (driver side only) |
| src/agents/xai_requests.rs | provider-grok/xaiAcpExtension.ts:861-1235; provider-grok/adapter.ts:171-230 | ported-to-Rust (plan fallback through the driver's last captured plan) |
| src/flavor.rs (`SubagentEndNotice`, `BackgroundStatus`, `BackgroundMutation`, `PromptContext`, `FlavorEvent::BackgroundTask`, `ExtRequest::CapturePlan` fallback, `ModelWrite::{Sequence, OrElse, OptionalConfigByCategory}`, hooks `subagent_end_notice`, `proposed_plan_markdown`, `background_task_id`, `is_persistent_background_tool`, `background_task_completions`, `background_tool_mutations`, `is_wake_notification`, `defers_finalize_for_background_work`, `preserve_runtime_on_settled_interrupt`, `settles_prompt_on_cancel`, `auth_policy_for`, `model_write_for`, `rewrite_user_text_for`) | provider-acp/adapterFlavor.ts:66-111,300-400 | adapted (Grok uses the shared `normalize_tool_call`, `extract_subagent`, `SubagentUpdate` and `FlavorEvent::FinishSubagent` of the registry slice; statuses are `TurnItemStatus`) |
| src/items.rs (normalized tool state kept, background task bookkeeping and hydration, injected monitor text, registered-task poll check, proposed-plan dedup, deferred work check for tasks) | provider-acp/adapter.ts:1152-1258,2474-2642,3187-3213,4047-4087,5480-5530; provider-acp/deferredBackground.ts:13-43; provider-acp/toolOutputText.ts:68-90 | adapted |
| src/subagents.rs (Grok subagents on the shared tracker: registered-task polls are tools, end notices in injected user text, `blocks_turn` for the deferral, subagents of a kept-running interrupted turn written as interrupted and then updated without a second item) | provider-acp/adapter.ts:2558-2621,3775-3797,4088-4111,4640-4670,6544-6556,7874-7900; provider-acp/deferredBackground.ts:13-43 | adapted |
| src/engine.rs (deferred finalize and debounce, wake frames, settled interrupt without cancel or MCP stop, cancel settles the prompt, background task events, composite model writes, per-session auth, async prompt rewrite) | provider-acp/adapter.ts:3880-3899,4459-4467,5422-5530,7874-8082; provider-acp/deferredBackground.ts:45-47,131-233; provider-grok/xaiAcpExtension.ts:1323-1357,1553-1560 | adapted |
| src/bin/acp_mock_agent.rs (`GOAT_ACP_GROK_KILL_TASK_SHAPE`, `GOAT_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL`, `GOAT_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED` / `GOAT_ACP_GROK_BACKGROUND_TASK_COMPLETION`, Grok models) | apps/server/scripts/acpMockGrokScenarios.ts:1-69; apps/server/scripts/acp-mock-agent.ts:431-461,1836-1980; apps/server/scripts/acpMockScenarioOptions.ts:11-18 | ported-to-Rust (v1 env names; v1's 120 ms pause before the monitor poll dropped) |
| src/bin/acp_mock_agent.rs (`GOAT_ACP_GROK_SCENARIO`, `GOAT_ACP_GROK_MODELS`, `GOAT_ACP_REJECT_SET_MODEL_META`, `inspect --json`) | frame shapes from provider-grok/xaiAcpExtension.test.ts and provider-grok/skills.test.ts | written new (GOAT 2 scenarios, marked) |
| tests/grok.rs | behaviours of provider-grok/adapter.test.ts, xaiAcpExtension.test.ts, skills.test.ts | written new against the v1 behaviour cited in each test |
| tests/grok_launch_env.rs | provider-grok/auth.ts:57-64; provider-grok/acpSupport.ts:164-168 (behaviours) | written new against the v1 behaviour cited in the file |

## Not carried, and why

- v1 post-settle continuation runs (`enablePostSettleContinuation`, wake buffer, `offerContinuationRun`,
  `recordWakeReport`, `pendingInjectedReport`, `midTurnUnreportedCompletedTaskIds`): need a host API
  for agent-started runs that GOAT 2's engine contract does not have. Wake frames after the turn
  ends are dropped.
- Subagent child threads and transcripts: GOAT 2 has no thread for a native subagent, so
  `child_thread_id` is None; child-session updates become `SubagentUpdate` progress through the
  shared tracker (src/subagents.rs).
- `extractContextUsage`, `getModelContextWindow`, `supportsCompaction`: no engine event or command
  for them in `goat2-engine-api`.
- `isBackgroundCommandTool` / `backgroundCommands` (restoring a replayed start ACK after the
  prompt settles): GOAT 2 writes a tool item once, so a structured task end is applied when it
  arrives, before or after the prompt settles (v1 waits for settlement).
- `textGeneration.ts`, memory isolation (`checkGrokMemoryIsolation`), the in-app API key sign-in
  (`makeGrokAuth`), `driver.ts` maintenance and `hostEnvironmentHash.ts`: host and settings
  concerns, not the session driver. `status.ts` probes belong to the probe slice.
