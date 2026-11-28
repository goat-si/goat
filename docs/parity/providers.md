# Part 2 provider matrix (P2-D)

The Part 2 brief asks, per provider, for six scenarios recorded on GOAT v1 and compared with GOAT 2's driver: one turn,
stop, approval, question, resume and subagent, plus a matching capability table (docs/lanes/PART2.md, P2-D row). Following
the owner's lift-first rule, each cell names the v1 recording that already covers the case; a dash marks a case with no v1
recording for that provider, which needs a new recording (Codex through the OpenCodex pool, as for child_wake_delegated;
other providers need the owner's go-ahead on accounts). Paths are under the pinned v1 export (916b5ccc).

Status (2026-11-29): Codex runs end to end on the real `goat2-host` through the GOAT 2 runner (crate README, "GOAT 2
target"); its one-turn, stop and resume cells pass as `simple_turn`, `interrupt_ack_then_terminal` and
`restart_idle_resume`. The approval, question and subagent cells, and every other provider, are planned: the v1 runner
replays Codex streams only so far, and the other GOAT 2 drivers are not wired into the host yet.

| Provider (GOAT 2 lane) | one turn | stop | approval | question | resume | subagent |
|---|---|---|---|---|---|---|
| Codex (lane B, `goat2-engine-codex`; host wired 3debd30) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/codex_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/codex_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/plan_questions/codex_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/codex_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/subagent_v2/codex_transcript.ndjson:1` |
| Claude (P2-A, `goat2-engine-claude`; host wiring pending) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/claude_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/claude_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/claude_transcript.ndjson:1` | - | `apps/server/src/orchestration-v2/testkit/fixtures/claude_idle_resume/claude_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/subagent/claude_transcript.ndjson:1` |
| Grok over ACP (P2-B) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/grok_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/grok_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/grok_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/plan_questions/grok_transcript.ndjson:1` | - | `apps/server/src/orchestration-v2/testkit/fixtures/grok_subagent_lineage/grok_transcript.ndjson:1` |
| ACP registry agent (P2-B) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/registry_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/registry_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/registry_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/acp_elicitation/registry_transcript.ndjson:1` | - | - |
| OpenCode (P2-S) | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_simple/opencode_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_interrupt/opencode_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_permission/opencode_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_question/opencode_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_resume_after_restart/opencode_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/opencode2_subagent/opencode_transcript.ndjson:1` |
| Cursor (P2-S) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/cursor_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/cursor_transcript.ndjson:1` | - | - | `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/cursor_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/subagent/cursor_transcript.ndjson:1` |
| Pi (P2-S) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/pi_transcript.ndjson:1` | - | - | `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson:1` | - |
| Muse (P2-S) | `apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/muse_transcript.ndjson:1` | `apps/server/src/orchestration-v2/testkit/fixtures/muse_permission/muse_transcript.ndjson:1` | - | - | `apps/server/src/orchestration-v2/testkit/fixtures/subagent_v2/muse_transcript.ndjson:1` |

Capability table: each GOAT 2 driver compares its `capabilities()` with the v1 values in its own tests (for Codex
`goat2/crates/goat2-engine-codex/tests/capabilities.rs:1`, for Claude `goat2/crates/goat2-engine-claude/tests/capabilities.rs:1`).
The parity check over the host's provider list waits for the host providers module (`subscribe_providers` is refused until
it lands).
