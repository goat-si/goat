# #3397 integration nits (record)

Branch: `chase/t3-261114-integration-nits`, from `chase/t3-261114-all` at 590cee0efb, pushed at `384c097e19` (part B, part A's INT-A-P3-1, merge of 4e096afdb0).

Merged into #3397 at 3d4a4192b4 (2026-11-16): lane head 384c097e19.

## Part B (integration review at 590cee0efb: APPROVE WITH NITS, two P3)

| finding | commit | change |
| --- | --- | --- |
| INT-B-P3-1 thread read guide | ddb7e1cedb | packages/contracts/src/agentSurface/entries/thread.ts:180, goat_thread_read guide: "about 30,000 characters" becomes "about 30,000 bytes" (threadReadItems.ts counts bytes); "a paginated read does so once it returns the untruncated result from offset zero" becomes "a paginated read does so with the page that reaches the end of the result's text" (OrchestratorMcpService.ts acknowledges on that page). Nothing else in the guide or the descriptions changes. docs/internals/agent-surface-audit.md is unchanged: the generator wrote the same file. |
| INT-B-P3-2 Cursor steer declined after Stop | 4407154226 | docs/user/cursor.md: if Stop arrives before Cursor answers the steer, the message stays in the stopped turn and is not sent, so send it again. The behaviour (Orchestrator.ts:5100-5122 drops the follow-up when stopReachedRun; the steer item written at :4507-4535 stays in the stopped run looking delivered) is goat#3491; upstream 2248ca8db9 has the same gap (same stopReachedRun drop, its stop-before-decline test checks only that nothing is queued, same doc sentence). |

## Part A

| finding | commit | change |
| --- | --- | --- |
| INT-A-P3-1 Cursor memory recovery test mock | 79fc75a5f3 | packages/provider-cursor/src/server/memoryRecovery.test.ts: the ./sdk.ts factory mock gains isCursorSdkError: () => false (adapter.ts imports it and calls it when a run is rejected). Fixture change only; expectations unchanged; the test passed before and after (3 passed), because its paths do not reach that call. |

Merge 384c097e19: origin/chase/t3-261114-all at 4e096afdb0 (a757f2974a goat-rename rules-meta names CodexAdapterV2.runtimePolicy.test.ts, 291fc475f1 CI scope, dev 7ab83f47f6 #3471), no conflicts. No test file moved or renamed on this branch.

On 384c097e19: format and lint pass on the three touched files; goat-rename --check 0; goat-rename tests (scripts/lib/goat-rename) 355 passed (12 files); memoryRecovery.test.ts 3 passed; packages/contracts agentSurface tests 48 passed (7 files); agent-surface audit --check and context-budget --check pass.

## Checks (pen-macmini, Node v26.12.1)

On 4407154226: format and lint pass; goat-rename --check 0; typecheck of packages/contracts and apps/server passes; packages/contracts agentSurface tests 48 passed (7 files); apps/server src/mcp/agentSurface tests 30 passed (5 files); agent-surface audit --check passes; context-budget --check passes (ACP instructions 6,143 of 6,144 B; the guide is not in that block).

NOT RUN: other test files (two text-only changes); a real client or provider.

Model: anthropic/claude-opus-5-5 via Codex in GOAT on pen-macmini.
