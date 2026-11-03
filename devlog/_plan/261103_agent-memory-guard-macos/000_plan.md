# 000 — macOS agent memory guard: plan and roadmap

Unit: GOAT design principle 7 on macOS. Branch `feat/agent-memory-guard-macos` from `dev` at 55a3236c86.
Class: C3 (server process control across adapters + a public settings contract). Kill authority makes the
PID-ownership rule C4-grade; it gets an independent terra audit and a fresh final review.

## Facts this plan rests on (verified 2026-11-03 at 55a3236c86)

- Linux caps agents with cgroups: `apps/server/src/process/agentScope.ts:205` sets MemoryHigh/MemoryMax on the agents
  slice; `oomKilled` (agentScope.ts:294-321) marks a thread; `ProviderEventIngestor.ts:751-753` rewrites the failed
  turn to "Killed: out of memory." with code `oom_kill`; `ProviderSessionManager.ts:2623/2689` calls `clear` before a new
  session so the mark answers only for the session that was killed (thread stays resumable).
- On non-Linux `make` returns `AgentScope.defaultValue()` (agentScope.ts:105): no limit, `oomKilled` always false.
- Every agent launch that matters already passes `AgentScope.wrap` with a `threadId`: Claude (ClaudeAdapterV2.ts:990),
  Codex (CodexAdapterV2.ts:1491, `shared: true`), ACP family (provider-acp AcpSessionRuntime), OpenCode
  (provider-opencode OpenCodeRuntime), Pi and Muse adapters. Terminals call wrap without a threadId
  (terminal/Manager.ts:1907) and stay unguarded.
- `agentScopeCommand` without a systemd scope already runs agents through `/bin/sh -c '...; exec "$@"'` on Linux
  (packages/shared/src/AgentScope.ts), so exec-preserved PIDs are a proven launch shape.
- No macOS per-process memory cap exists in comparable tools (report §3.4); pm2 polls RSS every 30 s; heap flags do not
  bound RSS (Claude 6–7.5 GB over a 4 GB heap cap). Field leaks: Claude 15 GB/18 h, Codex 3.7 GiB, OpenCode 1.8 GB/30 min,
  1,182 MCP children 33 GB. Healthy sessions: 135–658 MB.

## Design (one paragraph)

On darwin, `wrap` for a thread-owned launch adds a per-server temp PID file argument; the launch script writes `$$`
there and execs the agent, so the agent itself reports its PID (ownership proven by construction, no matching by name).
A guard loop wakes every 30 s; with nothing watched it does nothing. Otherwise it reads pending PID files, runs one
`ps -axo pid=,ppid=,pgid=,rss=`, keeps only roots whose parent is still this server, groups each root with its ppid
descendants and members of its process group, and compares the RSS sum with the limit. An owned tree over the limit is
SIGKILLed as a whole (Linux OOMPolicy=stop); a shared tree (Codex app-server) loses its largest process and that
process's subtree (OOMPolicy=continue). The thread is marked before the signal, so the existing ingestor path reports
"Killed: out of memory." and `clear` resets it on the next session.

Limit setting `agentMemoryLimitGiB`: null = automatic, 0 = off, 1..1024 GiB. Automatic = clamp(RAM/2, 4 GiB, 16 GiB):
16 GB Mac 8 GiB, 32 GB+ 16 GiB. Rationale: 4 GiB floor is 6x the largest healthy session (658 MB) and leaves room for
an agent's own builds and test workers; half of RAM keeps one agent from rivalling the rest of a small Mac; the 16 GiB
ceiling still stops the documented 15–33 GB runaway cases on large Macs. SETTINGS_ACCESS: `person` (a runaway agent
must not lift its own cap).

## Work phases

| Id | Doc | Outcome | Depends |
|---|---|---|---|
| wp0 | this + 010 + 020 | Roadmap locked, audited | — |
| wp1 | 010 | Failing-first guard tests, guard, darwin hook, setting, SETTINGS_ACCESS, web row, user docs | wp0 |
| wp2 | 020 | 100-agent cost measured before/after, PR, exact-head CI, fresh review, merge, origin.report | wp1 |

## Out of scope

Linux cgroup behaviour, Windows, macOS Force stop through `kill`, mobile settings UI, release/nightly, app restarts,
writes to the live userdata, repo-wide checks. Codex app-servers that survive a server restart (stabilization thread 4)
re-parent away from the new server and are not watched after restart; recorded as a limitation.

## Coordination

Other stabilization threads (1 error net, 2 reader admission, 3 backend shutdown/circuit breaker, 4 Codex restart
survival) may touch CodexAdapterV2.ts or server.ts. This unit edits neither adapter; server.ts only if the AgentScope
layer needs the settings layer provided. Before merging, rebase only on CONFLICTING, per AGENTS.md.


## Status after wp0 (2026-11-03)

The audit changed the design: the guard learns each agent from its spawn site (AgentScope.watch with the child),
signals only after a synchronous liveness check inside a check-phase callback, and uses min(RAM/2, 16 GiB) as the
automatic limit. 010 is the binding implementation doc; 001-005 record why.
