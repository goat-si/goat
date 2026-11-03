# 002 — Audit round 2 resolution (supersedes conflicting text in 000/001/010)

Round 2: FAIL, 4 blockers. Changes below; where 002 and 001 differ, 002 wins.

## B1 signal race — redesigned: no per-descendant PID signals

The guard never signals a descendant by PID. It sends exactly one signal per decision:

- root is a process-group leader (pgid === pid; true for Claude, Pi, OpenCode, Muse/ACP when detached):
  `kill(-root.pid, SIGKILL)`;
- otherwise `kill(root.pid, SIGKILL)`.

Why this is sound: the root's PID (and so its group ID) cannot be handed to another process while the root is alive or
an unreaped zombie of this server, and XNU never allocates a PID equal to a live process group ID (kern_fork.c, confirmed
in round 2). The adapters' exit hooks release the registration (below), and the release runs before any later guard
decision, so a reaped root is never signalled from a fresh decision. The only remaining window is a root that exits
and is reaped between the ps snapshot and the signal of the same tick; a different process can receive that PID only
after the allocator wraps the whole PID space back onto it inside that window (sequential allocation, PID_MAX 99,999).
The identity check (pid, start second recorded at acceptance, start <= PID file mtime, ppid === server) rejects any
reuse that happened before the snapshot. That residual is stated in the PR; there is no pidfd on macOS to remove it.
Descendants that left the root's group (setsid daemons) are counted toward the tree but never signalled: fail closed.
They lose their parent when the group dies, reparent to launchd and drop out of every tree.

## B2 failure paths — one helper, three sites, explicit tests

NEW `apps/server/src/orchestration-v2/agentOomFailure.ts`:
`withAgentOom(threadId, failure): Effect<failure>` — when `AgentScope.oomKilled(threadId)` is true, returns the failure
with message "Killed: out of memory." and code "oom_kill". Used at:
- ProviderEventIngestor.ts:751 (replaces the inline Linux rewrite, same behavior),
- RunExecutionService.ts:1799 (event-stream failure; provider_process_exit),
- RunExecutionService.ts:2160 (start failure),
- ProviderTurnStartService.ts:626 (session start failure).
Injection: AgentScope is a Context.Reference; the live layer is provided once with provideMerge at server.ts:1323 for the
whole application graph, which is how ProviderEventIngestor already gets the Linux scope today. Tests prove the wiring:
RunExecutionService.terminationCause.test.ts gets a case where an AgentScope with `oomKilled → true` is provided and a
provider_process_exit failure becomes "Killed: out of memory." / oom_kill; agentOomFailure gets its own contract test
for the unmarked case.

## B3 registration lifetime

darwin `wrap` returns `unit: "goat-agent-<uuid>"` (the PID file id). Adapters that already release Linux scopes on exit
or scope close (Claude exit handler ClaudeAdapterV2.ts:1007, ACP AcpSessionRuntime.ts:1386-1389 + exitCode fork, Pi
adapter.ts:484-486, Muse adapter.ts:1675-1679) call `agentScope.stop(unit)`, which on darwin removes the registration and
deletes the PID file. Codex and OpenCode do not call stop: their registrations end when the root disappears or its
identity changes at the next tick. Spawn failures release through the same finalizers; unresolved files are bounded at
500 (oldest dropped). Off → exit → on: a stale file whose process exited fails the identity check (absent, or start after
mtime) and is dropped.
`clear(threadId)` bumps the generation and drops the mark. Rebuttal on "exclude old registrations from signalling":
an old tree that is still alive still threatens the machine, so it stays guarded; it can never mark the new session
because marks require the current generation.

## B4 shared trees — product policy

The limit applies to a shared provider server as a whole (Codex app-server, OpenCode server). Over the limit, the server
is stopped (root signal per B1); every turn running on it fails through the existing provider-exit path, and each thread
continues with its next message, which starts a fresh server. No thread is marked, because no single thread can be
blamed; the guard logs a warning with provider name, RSS, limit and process count. The registration ends with the root,
so there is no repeat loop: a fresh server registers anew. The "largest child subtree" rule from 001 is withdrawn.

## Tests (replace 001 F8)

TestClock + fake ps rows (pid, ppid, pgid, rss, start) + fake PID files (pid, mtime) + recording signal fn:
1 owned leader over limit → one `-pgid` signal; thread marked; other agent/unrelated rows untouched.
2 owned non-leader → one root PID signal.
3 reuse before snapshot: start after mtime → rejected; start second changed between ticks → forgotten, no signal.
4 same-second reuse between ticks is caught by ppid change or missing row (fail closed: forgotten).
5 setsid descendant counted but never signalled.
6 shared over limit → root signal, nobody marked; registration gone next tick.
7 signal ESRCH → no mark.
8 stop(unit) before tick → no signal, PID file deleted.
9 clear then kill of the old tree → new generation unmarked.
10 nothing watched or limit off → no ps; off → exit → on → stale file dropped; off → on → live registration watched.
11 ps failure skips one tick; next tick works.
12 it.live: real spawns (NodeChildProcess detached group like Claude; effect ChildProcessSpawner like Codex/ACP/Pi)
   → PID file == child.pid, ps ppid == process.pid, stdin/stdout round trip through /bin/cat.
Plus RunExecutionService.terminationCause.test.ts OOM case and agentOomFailure test.

## Measurement command update (020)

ps: `LC_ALL=C ps -axo pid=,ppid=,pgid=,rss=,lstart=`.

