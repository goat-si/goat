# 001 — Audit round 1 resolution (supersedes conflicting text in 000/010)

Auditor (terra, round 1): VERDICT FAIL, 8 findings. Each is folded below; 010 sections that conflict are replaced by this.

## F1 PID ownership — folded

Identity is (pid, start second). The ps call becomes `LC_ALL=C ps -axo pid=,ppid=,pgid=,rss=,lstart=` (lstart = last five
tokens). A root is accepted only when (a) the agent wrote its own `$$` to the PID file before exec, (b) its ppid is this
server, and (c) its start second <= the PID file's mtime second: the writer was alive at mtime and no two live processes
share a PID, so a live process with that PID that started no later than mtime is the writer. The accepted start second is
stored and must match on every later tick, otherwise the root is forgotten (exited/reused). XNU allocates PIDs
sequentially up to 99,999, so a reuse that also lands in the same second needs ~100k forks in one second; the residual is
documented, not hand-waved.
Descendants come only from the same snapshot's ppid lineage of an accepted root; each target must also have a start
second >= the root's. Signals are sent in one synchronous block immediately after the snapshot resolves (no await
between parse and kill), so the snapshot→signal window is the parse time (measured in wp2, ~ms) and reuse inside it
requires a full PID wrap. pgid members are included only when pgid === root.pid while that root is accepted: POSIX/XNU do
not allocate a PID that equals a live process group ID, so such a group was created by the root (or its descendants via
setpgid within its session). This satisfies AGENTS.md rule 1: the root PID is captured at spawn (self-reported by the
spawned process), nothing is found by name/path matching.

## F2 coverage — decided per caller

| Caller | wrap input | Guard |
|---|---|---|
| Claude native binary (ClaudeAdapterV2.ts:990) | threadId, owned | watched, attributed |
| Claude script entry / missing path (:984) | wrap skipped | not watched (same gap as Linux) |
| Codex app-server (CodexAdapterV2.ts:1491) | threadId, shared | watched as shared, not attributed |
| ACP family (AcpSessionRuntime.ts:1376) | threadId, owned | watched, attributed; shell launches skip wrap (:1373) → not watched |
| Pi (provider-pi adapter.ts:476), Muse (adapter.ts:1667) | threadId, owned | watched, attributed (Muse re-resolves /bin/sh and appends serve args after ours: argv stays sh -c script t3-agent pidFile muse ...) |
| OpenCode server (OpenCodeRuntime.ts:680) | no threadId, shared | watched as shared, not attributed |
| Terminals (terminal/Manager.ts:1907) | survivesRestart | never watched |

Rule: watch every wrap call with `survivesRestart !== true`; attribute only owned calls with a threadId.

## F3 shared trees — folded

A shared tree over the limit loses the non-root process with the largest own RSS together with its ppid subtree, and
stays watched. Only when the root alone is over the limit (root RSS > limit) is the root killed (whole tree); every thread
on it then fails through the existing provider-exit path. Shared kills never mark a thread (Linux OOMPolicy=continue does
not attribute either). Logged at warning with rss/limit/process count.

## F4 failure path — folded

Owned providers whose death surfaces as an event-stream failure finalize in RunExecutionService.ts:1799-1808, not the
ingestor. Add the same hook there: `(yield* agentScope.oomKilled(threadId))` → `makeProviderFailure({ cause, message:
"Killed: out of memory.", code: "oom_kill", class: "unknown" })`. This also improves Linux. The mark is set only after
the synchronous SIGKILL of the root returned without ESRCH, in the same JS turn, so the child's exit callback cannot run
before the mark and a root that had already exited is never marked. Resumability: unchanged from Linux — the thread's
next message opens a new session (ProviderSessionManager clear). wp1 C adds a focused test only for the new
RunExecutionService branch if that suite has a cheap fixture; otherwise the guard tests prove the mark and the NOT RUN line
names the per-provider live kill.

## F5 lifetime — folded

Registrations carry the thread's generation; `clear(threadId)` bumps it and drops the mark. A kill marks a thread only
when the registration's generation is current, so an old tree killed after a new session opened cannot mark the new
session. Pending PID files stay pending (no 2-tick expiry) until resolved or until 500 pending entries (oldest dropped,
file deleted). While the limit is off, nothing is sampled and registrations stay; turning it on watches them on the next
tick. ps failure: skip the tick; first failure logs a warning, repeats debug, recovery info. A missing PID file (write
failed) leaves the agent unwatched and pending until the bound. Partial kill (EPERM/ESRCH on some targets) is logged with
counts; the next tick re-evaluates.

## F6 settings surfaces — folded

New key `agentMemoryLimitGiB` must appear in SettingsPanels.tsx dirty labels (~:556) and reset-all (~:677), and a
settingsSearch.ts entry. All three files are at their code budgets: wp1 extracts a coherent block from each into a new
module (e.g. the "Updates and background" section into `UpdatesSettingsSection.tsx`; the general-page search items
into their own file) so each file ends at or below its recorded length. Never raise a baseline. Not added to project or
shared key lists (machine-only).

## F7 default — changed

Automatic = min(RAM/2, 16 GiB) (no 4 GiB floor, so a small Mac never gets a limit above half its RAM): 8 GB → 4 GiB,
16 GB → 8 GiB, 32 GB+ → 16 GiB. It is a per-agent limit: it does not cap many agents together (host pressure admission,
docs/user/usage.md "Machines under heavy load", covers that), and RSS sums count shared pages once per process, which can
only make the guard act earlier. User docs say both plainly.

## F8 tests — expanded (TestClock, fake ps rows + fake pid files + recording kill)

1 owned tree over limit: root, grandchildren, a pgid member reparented to launchd killed; other agent, unrelated rows,
  server untouched; thread marked.
2 PID reuse: root row with a start second after the pid file mtime → never killed, forgotten; root whose start second
  changes between ticks → forgotten.
3 descendant with start second before the root's → excluded from targets.
4 shared tree: largest non-root subtree killed, root kept and still watched next tick; root alone over limit → whole
  tree; no thread marked either way.
5 root already gone at signal time (ESRCH) → no mark.
6 clear then late kill of the old tree → new session not marked.
7 no ps while nothing is watched or while the limit is off; off→on watches existing registrations.
8 ps failure skips the tick and the next tick works.
9 it.live contract: real spawn of the PID-file launch command via NodeChildProcess (Claude-style detached group) and via
  the effect ChildProcessSpawner (Codex/ACP/Pi style) → file holds child.pid, ps shows ppid = process.pid, argv after
  exec is the agent's, stdin/stdout pass through (echo round trip with /bin/cat).

