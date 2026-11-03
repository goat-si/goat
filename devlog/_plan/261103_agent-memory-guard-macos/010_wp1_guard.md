# 010 — wp1: guard, spawn-site watch, OOM failure helper, setting, UI, docs (final, after 6 audit rounds)

Supersedes the earlier 010 draft (kept outside the unit at /tmp/amg-010-draft.md) and 001-005 where they differ.
Base 55a3236c86; re-verify line numbers before editing. Order: t1 failing-first tests (guard core, failure helper,
RunExecutionService/ProviderTurnStartService cases) → t2 implementation → commit after each green step.

## 1. packages/shared/src/AgentScope.ts (MODIFY, upstream file: additive only)

```ts
export interface AgentProcess {
  readonly pid: number;
  /** True until this server has reaped the child. Read only inside a check-phase callback (see agentMemoryGuard). */
  readonly isRunning: () => boolean;
}
// AgentScopeShape:
  /** Puts a spawned agent under the macOS memory guard; elsewhere a no-op (Linux uses cgroups). */
  readonly watch: (input: { readonly process: AgentProcess; readonly threadId?: string | undefined;
    readonly shared?: boolean | undefined }) => Effect.Effect<void>;
// defaultValue: watch: () => Effect.void
export const nodeChildAgentProcess = (child) => child.pid === undefined ? undefined
  : { pid: child.pid, isRunning: () => child.exitCode === null && child.signalCode === null };
export const handleAgentProcess = (handle: ChildProcessSpawner.ChildProcessHandle): AgentProcess =>
  ({ pid: Number(handle.pid), isRunning: () => Effect.runSync(handle.isRunning) });
```
Linux `make` (agentScope.ts) adds `watch: () => Effect.void` to its shape.

## 2. apps/server/src/process/agentMemoryGuard.ts (NEW, GOAT-owned, < 400 lines)

Pure:
- `ProcessRow { pid; ppid; pgid; rssBytes; zombie }`; `parseProcessTable(stdout)` for
  `ps -axo pid=,ppid=,pgid=,rss=,stat=` (rss KiB → bytes; stat starting with Z → zombie; malformed lines skipped).
- `treeOf(rows, childrenByPpid, rootPid)` → `{ rssBytes, processCount, leader }` or undefined (root + ppid descendants +
  rows with pgid === rootPid, visited set; undefined when the root row is missing or a zombie).
- `automaticAgentMemoryLimitBytes(totalBytes) = Math.min(Math.floor(totalBytes / 2), 16 * GiB)`.
- `resolveAgentMemoryLimitBytes(setting: number | null, totalBytes)`: null → automatic; 0 → null (off); n → n GiB.

Core `makeAgentMemoryGuard(deps)` (Effect.fn("AgentMemoryGuard.make")), deps injectable:
`sample: Effect<ReadonlyArray<ProcessRow>, unknown>`, `limitBytes: Effect<number | null>`,
`signal: (pid: number) => void` (SIGKILL; throws like process.kill; negative pid = group),
`inCheckPhase: <A>(block: () => A) => Effect<A>` (live: setImmediate; tests: Effect.sync), `SAMPLE_INTERVAL = "30 seconds"`.
State: `watched: Map<pid, { process, threadId?, shared, generation }>`, `generations: Map<threadId, number>`,
`marked: Set<threadId>`. Loop forked scoped: sleep SAMPLE_INTERVAL then tick, forever.
tick: watched empty → return; limit null → return (registrations kept); sample (failure: first warning, repeats debug,
recovery info; skip tick); per registration: tree undefined → skip (forget if `isRunning()` false); rss <= limit →
continue; else collect a decision. Then ONE `inCheckPhase` block for all decisions:
```
if (watched.get(pid) !== reg) continue           // replaced since the decision (PID reuse): leave the new one alone
if (!reg.process.isRunning()) { watched.delete(pid); continue }
try { signal(pid) } catch { continue }            // ESRCH etc: no mark
watched.delete(pid)
if (!reg.shared && reg.threadId !== undefined && generations.get(reg.threadId) === reg.generation) marked.add(reg.threadId)
if (decision.leader) try { signal(-pid) } catch { note partial kill }
```
then logWarning per decision with threadId, shared, rssBytes, limitBytes, processCount. A code comment carries the
check-phase argument (libuv 1.52.1 `uv__wait_children` runs inside `uv__io_poll` and finishes every exit callback of the
batch before the poll phase ends; Node sets exitCode/signalCode and the effect spawner completes its exit Deferred in
onexit) and its condition (the same Node loop owns and reaps the child).
Shape: `watch` (register with the thread's current generation; prune entries whose isRunning() is false; bound 1,000),
`oomKilled(threadId)` → marked.has, `clear(threadId)` → bump generation and delete mark.

Live `makeDarwinAgentScope` in the same file: sample via ProcessRunner `ps -axo pid=,ppid=,pgid=,rss=,stat=`
(timeout 5 s); signal = `process.kill(pid, "SIGKILL")`; limitBytes from `ServerSettingsService.getSettings` →
`resolveAgentMemoryLimitBytes(settings.agentMemoryLimitGiB, NodeOS.totalmem())` (read failure → automatic);
wrap passthrough (as today); stop → void; kill → false (Force stop out of scope).

## 3. apps/server/src/process/agentScope.ts (MODIFY, thin hook)

Before the linux check at :105: `if (platform === "darwin") return yield* makeDarwinAgentScope;`. If `make` now needs
ServerSettingsService, provide `layerServerSettings` to `AgentScopeLive.layer` at server.ts:1323 and keep
agentScope.test.ts compiling.

## 4. Spawn sites (one watch call each)

- ClaudeAdapterV2.ts `spawnClaudeCodeProcess` (~:1018), after `spawnedProcess = child`:
  `const watched = nodeChildAgentProcess(child); if (watched) runFork(agentScope.watch({ process: watched, threadId: input.threadId }));`
- CodexAdapterV2.ts layerAppServerClientFactory.open after `spawner.spawn(command)` (~:1621):
  `yield* agentScope.watch({ process: handleAgentProcess(handle), threadId: input.threadId, shared: true });`
- AcpSessionRuntime.ts after `spawner.spawn` (~:1428): watch every launch (wrap or shell), owned,
  `threadId: yield* AgentScopeThreadId`.
- OpenCodeRuntime.ts after the server spawn (~:710): watch, `shared: true`, no threadId.
- provider-pi rpc.ts: `PiRpcSpawnOptions.threadId?`; after spawn watch `handleAgentProcess(child)`; adapter.ts:488 passes
  `threadId: input.threadId` (fork connection at :3044 not watched: short-lived).
- Muse: not watched (the SDK hides its Node child). Terminals: not watched.

## 5. OOM failure helper (NEW apps/server/src/orchestration-v2/agentOomFailure.ts)

`withAgentOom(threadId, failure)`: when `(yield* AgentScope).oomKilled(threadId)` → `{ ...failure, message: "Killed: out
of memory.", code: "oom_kill" }`, else unchanged. Use at ProviderEventIngestor.ts:751 (replaces the inline rewrite),
RunExecutionService.ts:1799 and :2160 (wrap the `makeProviderFailure(...)` before `makeFailedTerminalEvent`),
ProviderTurnStartService.ts:626.

## 6. Contracts and settings

- packages/contracts/src/hostPressure.ts: `AgentMemoryLimitGiB = Schema.Int.check(Schema.isBetween({ minimum: 0,
  maximum: 1024 }))` with doc (null automatic = half of RAM up to 16 GiB, 0 off) and exported
  `AgentMemoryLimitSettingsFields` / `AgentMemoryLimitSettingsPatchFields`.
- packages/contracts/src/settings.ts (budget 2170, now 2169): spread both; stay within budget by moving a coherent block
  out (never raise the baseline).
- settingsAccess.ts: `agentMemoryLimitGiB: person("It is this machine's memory safety limit for agents; a person sets it."),`.
- Not added to project-scoped or shared key lists.

## 7. Web

New `AgentMemoryLimitSetting.tsx` row in "Updates and background" (server scoped): Automatic switch (null) + GiB number
field (0 = off) + reset. Add to SettingsPanels dirty labels (~:556) and reset-all (~:677) and a settingsSearch entry
`agent-memory-limit`. SettingsPanels.tsx (1755) and settingsSearch.ts (1437) are at budget: extract a coherent block from
each so both end at or below budget.

## 8. Docs

docs/user/usage.md after "Machines under heavy load": "Memory limit for agents (macOS)": what happens, automatic limit,
Settings path, per agent (not all agents together), the thread continues with the next message.

## 9. Tests

agentMemoryGuard.test.ts (it.effect, TestClock, fake rows/AgentProcess/signal, inCheckPhase = Effect.sync):
1 owned leader over limit → pid then -pid, marked, others untouched; 2 non-leader → pid only; 3 isRunning false → no
signal/mark, forgotten; 4 setsid descendant counted, never signalled; 5 shared → root signalled, unmarked; 6 clear → old
tree kill leaves new generation unmarked; 7 no ps when nothing watched or limit off; off→on watches; 8 ps failure skips
one tick; 9 root missing from ps → no signal; 10 group signal throws → still marked; 11 a registration replaced under the
same PID between decision and check phase is neither signalled nor removed.
ProviderEventIngestor.test.ts: a failed turn.terminal becomes "Killed: out of memory." / oom_kill only when the
AgentScope override reports the thread OOM-killed; unmarked keeps the provider failure.
it.live contract: one child each via NodeChildProcess and effect spawner: isRunning true before exit, false inside the
exit listener and inside the live inCheckPhase scheduled from it.
agentOomFailure, RunExecutionService (stream :1799, start :2160), ProviderTurnStartService (:626): OOM and unmarked
cases with an AgentScope override. ProviderSessionManager.test.ts:1055 (existing) covers clear before the next session.
Verification: vp test run on the touched test files; vp run check:changed.

