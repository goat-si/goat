# 000 — Codex turns survive a GOAT server restart (roadmap)

Worktree: /Users/jun/.goat/desktop-nightly/worktrees/goat/feat-codex-session-survives-restart (branch feat/codex-session-survives-restart, base origin/dev 55a3236c86).
Class: C4 (process lifecycle, persisted ownership records, settings contract, shutdown semantics). Plan units are not committed (devlog/_plan excluded via .git/info/exclude).

## Objective
When the GOAT server stops for a crash, restart or update, the Codex app-server keeps running and in-flight Codex turns keep working.
After startup the restart-continuation run reattaches to the same app-server and adopts the native turn (still running, or finished while
GOAT was down) instead of sending turn/start. If reattach is impossible, the existing restart continuation runs unchanged.

## Facts that shape the design
- F1 GOAT runs ONE shared Codex app-server per provider instance, not one per thread: CodexAdapterV2.ts:285
  supportsMultipleProviderThreadsPerSession: true -> Orchestrator.ts:1181-1185 derive.providerSession -> IdAllocator.ts:255
  "provider-session:provider-instance:<id>:shared". Live check 2026-11-03: exactly one codex app-server (pid 77290, RSS ~565 MB,
  37 children) under GOAT Nightly (pid 17531). One restart therefore cuts every Codex turn on the instance at once.
  Consequence: one ownership record + one socket per instance; zero extra processes. Per-thread split (T3 PR #26253, Synara) and
  jemalloc arena tuning (openai/codex#54845) are separate follow-ups, out of scope here.
- F2 Claude's detached:true is a process-group watcher that kills the CLI on pipe EOF, including server crash
  (ClaudeAdapterV2.ts:378-410). No provider survives a restart today.
- F3 Experiment (001_experiment.md): codex-cli 0.163.0 `app-server --listen unix://PATH` = WebSocket over UDS; survives client SIGKILL;
  a reconnect mid-turn receives the rest of the turn; a turn finished while detached is visible via thread/resume history;
  no replay of missed notifications; process never exits on its own when idle; single frame > 16 MiB closes the connection.
- F4 Codex unloads a thread only when it has no subscribers AND is inactive for thread_unload_delay
  (codex-rs app-server/src/request_processors/thread_lifecycle.rs:58-64), so an active turn survives client disconnect.
- F5 GOAT MCP tokens are per-run and never persisted; a pre-restart token is refused as earlier_server
  (McpSessionRegistry.ts:62-72, mcpAuthResponse.ts:22). Codex keeps the old Authorization header in thread config
  (CodexAdapterV2.ts:1420-1425); config/mcpServer/reload does not replace thread overrides.
- F6 Server shutdown order: prepareForShutdown (continuation intent) then providerSessions.shutdown (serverRuntimeStartup.ts:561-563).
  The server cannot tell quit from restart: both are SIGTERM.

## Decisions (with authority)
- D0 Design B and PR split (orchestrator, 2026-11-03): see 012; PRs may be split.
- D1 Default (orchestrator, 2026-11-03): protect crash/restart/update by default; app quit keeps today's behavior (stop);
  keeping turns running after quit is a setting, default off. Setting key: codexTurnsSurviveServerStop: "off" | "restart" | "always",
  default "restart". Windows: always stdio (no detached mode).
- D2 Stop reason (agreed with thread 3, goat-thread mcp:43b5da61): desktop writes <stateDir>/desktop-stop-intent.json
  {version:1, pid, reason: quit|relaunch|update-install|recovery-retry|recovery-stop|instance-closed, requestedAt} atomically
  before SIGTERM; server reads once, accepts only pid === process.pid, deletes. Contract file packages/contracts/src/desktopStopIntent.ts
  (thread 3 owns; whichever PR lands second rebases). Restart reasons = {relaunch, update-install, recovery-retry}.
  Server-owned restart paths (runtimeDrain shutdown for SSH/runtime updates) mark restart in-process.
  Missing/invalid/other pid -> treated as quit (safe default).
- D3 MCP token (orchestrator): no token handoff in this PR. A surviving turn's goat_* calls get a clear non-retryable refusal
  ("server restarted; GOAT tools unavailable for the rest of this turn; recovers next turn"); PR body + test (old token refused after
  restart, next turn's token works). Token-handoff design with threat model goes to 005_token_handoff_proposal.md for the parent.
- D4 No auto-restart of in-progress turns: adoption never re-sends a turn; a dead retained process falls back to the existing
  continuation (chain limit MAX_CONTINUATION_CHAIN unchanged); no respawn loop is added.
- D5 Merge order: PR #2418 (thread 3) -> thread 3 stop-intent PR -> this PR; rebase on serverRuntimeStartup.ts shutdown block.

## Document index (read in this order)
- 000 this plan; 001 experiment; 005 token-handoff proposal (for the parent, not in scope).
- 014_pr_a_final.md: CANONICAL PR-A plan (wp1+wp2). Supersedes 010, 020, 013 for PR-A. Audit NEAR-PASS (round 13).
- 012_design_b.md: design B for PR-B (wp3+wp4), chosen by the orchestrator 2026-11-03. Gets its own P/A before wp3; open items
  listed in the A>B attest residual (stop-obligation durability, process-loss fallback durability, import fence, guard at client
  construction).
- History only (superseded): 010, 020, 030 (§1 stop intent and §2 retention still referenced by 012), 006-009, 011.
- Rejected designs and why (for the PR-B body, condition 4): live rebinding of a running turn failed four audit rounds on event
  races (replay vs live, completion overtaking import, request replay after resume, subagent ancestry, permit re-entry); deferred
  continuation (011) hid running work and lost the final answer.

## Work-phase map (dependency order)
| WP | Doc | Outcome | PR |
|---|---|---|---|
| wp0 | 000-014 | roadmap + research (docs only) | - |
| wp1 | 014 §1-§2 | message-channel transport + UDS WebSocket connector | PR-A |
| wp2 | 014 §3-§7 | detached launcher, pid handshake, group identity, startup cleanup, block check, factory extraction | PR-A |
| wp3 | 012 | design B: survival, visible waiting turn (contracts survivingRestart), import at end, Stop/Steer, fallback | PR-B |
| wp4 | 040 + 012 B8/B9 | docs, settings (codexTurnsSurviveServerStop), real-client pass web+mobile, PR-B delivery, origin.report | PR-B |
PR-A merges first (after thread 3's #2418 if they touch the same block); PR-B stacks on PR-A.

## Verification floor (C4)
Failing-first tests per WP (deterministic: in-memory channels, fake process table, TestClock, Deferred); vp test run <files>;
vp run typecheck; vp run check:changed before push; independent terra review per cycle; runtime transcript on an isolated dev server
with a mock Responses provider (no paid model, no real ~/.goat); exact-head goat-ci-result SUCCESS; node scripts/merge-pr.ts.

## Resource parity (c-6)
Same process count (one shared app-server per instance). App-server fds 48 (socket) vs 47 (stdio) fresh; RSS 61.9 MB vs 61.4 MB.
GOAT side: 1 UDS socket replaces 3 pipes. stderr goes to a per-instance log file opened by the child only.


## Amendment P2 (parent, 2026-11-03): blast radius is now in scope (wp5, c-8)
Trigger: 00:20:52Z one shared app-server (provider-session:provider-instance:codex:shared) ended and six Codex turns died together
(direct cause: CodexRequestDeadline 30 s config/read escalated to client termination; thread 9 mcp:ba7eb59f fixes that). The
"everything dies together" structure remains for crashes/OOM/Codex bugs. wp5 runs after PR-A merges, before or alongside PR-B:
measure shared vs per-thread vs N shards (RSS/anon with and without a jemalloc arena limit, fds, processes, at 100 agents), choose
per-thread only if memory fits, else fixed-size shards keyed by thread; build on the detached ownership records; failing-first test
that ending one app-server leaves another's turns running; default + setting from the measurement (SETTINGS_ACCESS); own PR; merge
order with thread 9 around CodexAdapterV2.ts.
- wp5 input (parent, 2026-11-03 09:28 KST): shared Codex = npm node wrapper (pid 3983, RSS 54 MB) + native body (pid 3989, RSS 633 MB,
  ~10 threads). Check (1) launching the native binary directly (no node wrapper: -54 MB per shard/thread; mind AgentScope.wrap and PATH
  resolution), (2) native RSS before/after a jemalloc arena limit on the same scenario, (3) baseline Claude CLI ~181 MB fresh, ~320 MB
  resumed, ~658 MB long-running per thread (anthropics/claude-code#98420). ChatGPT app shares one app-server connection per host
  (getAppServerConnection(hostId)), so it is not a split precedent; T3 #26253 (in progress) and Synara (per thread) are.
