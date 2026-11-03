# 003 — Audit round 3 resolution (supersedes 001/002 where they differ)

## R1 signal ownership — tightened kill sequence, supervisor rejected with reasons

Sequence for an accepted root over the limit, in one synchronous block right after the snapshot (no await):

1. Skip if the snapshot shows the root as a zombie (stat Z) or any identity field changed.
2. `kill(root.pid, SIGKILL)`. ESRCH → stop, no mark (already reaped).
3. Mark the thread (owned, current generation) in the same JS turn.
4. If the snapshot showed pgid === pid: `kill(-root.pid, SIGKILL)`.

Step 4 is provably safe: after step 2 the root is dead but unreaped (Node reaps only from the libuv loop, and we have not
yielded), so its PID, and with it the group ID, cannot be reallocated (XNU kern_fork.c refuses a PID equal to a live
process or a live pgid). Only step 2 carries the residual: the root exits, Node reaps it, and the allocator hands that
exact PID to another process in the window between ps sampling it and step 2. With identity = (pid, ppid === server,
start second <= PID file mtime, start second unchanged since acceptance) any reuse before the snapshot is rejected; reuse
inside the window needs the allocator to sit on that PID at that moment. Wait-free per-PID proof needs a pidfd, which
macOS lacks.

The in-group supervisor the auditor suggested (a watcher shell per agent that runs `kill -KILL 0` on an IPC command)
was evaluated and rejected: (a) it only works for roots that lead their own group, so Codex (non-detached today) would
need a setpgrp exec shim that changes how it dies with the server and collides with stabilization thread 4 (Codex
restart survival); (b) the watcher must notice its agent's death without a server pipe, which means a polling loop or a
leaked sleeping process per agent after a server crash; (c) it adds a resident process per agent, the overhead the
isolation report says to avoid. The residual above is what pm2's 30 s RSS check and every PID-based supervisor on
macOS accept; it is recorded in the PR and in a code comment.

Mislabel residual: a root that exits on its own inside the window becomes a zombie, step 2 succeeds, and the thread is
labelled out of memory although it ended at that instant while over the limit. Recorded, not fixed.

## R2 release ordering — no longer needed for safety

Safety no longer depends on exit hooks: a stale registration is rejected by the identity check in step 1/2. `stop(unit)`
from the adapters that already call it (Claude, ACP, Pi, Muse) only frees memory and deletes the PID file early; Codex and
OpenCode registrations end when the root disappears from ps. Claude's custom `spawnClaudeCodeProcess` override (tests
only) bypasses nothing safety-relevant. Tests: stale registration after exit (row missing / identity changed) never
signals.

## R3 attribution — fixed by step order

The mark follows a successful signal to the root itself (step 2), never the group signal, so a live group member cannot
make a dead root look OOM-killed.

## R4 tests per failure site

- ProviderEventIngestor: existing Linux OOM test (if present) keeps passing through the helper; otherwise add one.
- RunExecutionService stream failure (:1799) and start failure (:2160): RunExecutionService.terminationCause.test.ts /
  RunExecutionService.test.ts with an AgentScope provided to the layer build (the testkit's layer composition gets an
  optional `agentScope` override) — one OOM and one unmarked case each.
- ProviderTurnStartService (:626): ProviderTurnStartService.test.ts, one OOM case.
- Next-session reset: guard test 9 (clear → unmarked).

