# 004 — Audit round 4 resolution: handle-bound kill authority (supersedes the PID-file design in 001-003)

The guard no longer learns PIDs from a launch script and no longer changes how agents launch on macOS. Each spawn site
that already holds the child registers it with the guard right after spawn, and the guard may signal a PID only after a
synchronous liveness check through that same child object.

## Mechanism

NEW in packages/shared/src/AgentScope.ts (default no-op; Linux no-op because cgroups already cap agents):

```ts
export interface AgentProcess {
  readonly pid: number;
  /** True until this server has reaped the child; read synchronously right before a signal. */
  readonly isRunning: () => boolean;
}
readonly watch: (input: { readonly process: AgentProcess; readonly threadId?: string | undefined;
  readonly shared?: boolean | undefined }) => Effect.Effect<void>;
export const nodeChildAgentProcess = (child) => ({ pid: child.pid, isRunning: () => child.exitCode === null && child.signalCode === null });
export const handleAgentProcess = (handle) => ({ pid: Number(handle.pid), isRunning: () => Effect.runSync(handle.isRunning) });
```

Why a true `isRunning()` proves ownership: Node reaps a child inside libuv's SIGCHLD processing and, in the same
synchronous callback, sets `exitCode`/`signalCode` and emits 'exit'. The effect spawner completes its exit Deferred
with `Deferred.doneUnsafe` inside its first 'exit' listener (platform-node-shared NodeChildProcessSpawner.ts:400-402),
so `handle.isRunning` flips in that same callback. JavaScript cannot run between the reap and that update, so when
`isRunning()` returns true inside our synchronous block, the PID is still held by our child (alive or an unreaped
zombie) and cannot belong to anyone else until we yield. This is the supervisor property the auditor asked for, provided
by the parent that already owns each child, with no resident process per agent.

Kill block (synchronous, right after the snapshot is parsed):
1. `isRunning()` false → forget the registration, no signal.
2. `process.kill(pid, "SIGKILL")`.
3. If the snapshot showed pgid === pid: `process.kill(-pid, "SIGKILL")` — the root is now dead but unreaped, so its
   PID, and the group ID equal to it, stay reserved (XNU does not allocate a PID equal to a live pgid).
4. Mark the thread (owned + current generation) in the same block.
Descendants outside the root's group are counted but never signalled (fail closed).

Sampling (ps) is only for measurement: the tree is root + ppid descendants + pgid members of the registered root. A
mismatch between snapshot and handle (root missing from ps while isRunning() is true) skips the tick for that root.
No PID file, no /bin/sh change, no lstart parsing.

## Attribution (R3)

Mislabel only possible when the root ended on its own after the snapshot and before the signal (it would be an unreaped
zombie). Policy: accepted and documented. The label appears only on a turn that failed; a root that dies on its own at
that instant while over the memory limit is a failure of the same cause in practice. Not tested as a race (needs a
real-time window); the deterministic test covers `isRunning() === false` → no mark.

## Spawn sites (one call each, after spawn)

| Site | Call |
|---|---|
| ClaudeAdapterV2.ts spawnClaudeCodeProcess (~:1018) | `runFork(agentScope.watch({ process: nodeChildAgentProcess(child), threadId: input.threadId }))` |
| CodexAdapterV2.ts layerAppServerClientFactory open (~:1613) | `yield* agentScope.watch({ process: handleAgentProcess(handle), threadId: input.threadId, shared: true })` |
| AcpSessionRuntime.ts after spawn (~:1418) | watch with `threadId: yield* AgentScopeThreadId` when the launch went through wrap |
| OpenCodeRuntime.ts after server spawn (~:700) | watch, `shared: true`, no threadId |
| Pi: provider-pi rpc.ts spawn (~:182) | watch with the threadId the adapter passes in its spawn options |
| Muse: sdk.ts handshake child | watch from adapter.ts when the SDK exposes the child; otherwise recorded as not watched |

Terminals never call watch. Claude script entries and ACP shell launches are watched too now (they spawn a child as
well), unless the site has no child object.

## Tests (replace earlier lists)

Guard (TestClock, fake rows, fake AgentProcess with a mutable running flag, recording signal fn):
1 owned leader over limit → signals pid then -pid; marked; other agents and unrelated rows untouched.
2 owned non-leader → pid only.
3 isRunning false → no signal, no mark, registration gone.
4 setsid descendant counted, never signalled.
5 shared over limit → root signalled, nobody marked.
6 clear → old tree killed later does not mark the new session.
7 nothing watched / limit off → no ps; off→on watches live registrations.
8 ps failure skips one tick.
9 root missing from ps while running → no signal that tick.
Contract (it.live): `handleAgentProcess` and `nodeChildAgentProcess` report false in the same callback as 'exit' (spawn
`/bin/sh -c 'exit 0'`, assert isRunning() inside the 'exit'/exitCode continuation is false and before exit true).
Failure sites: agentOomFailure helper used at ProviderEventIngestor :751, RunExecutionService :1799 and :2160,
ProviderTurnStartService :626, each with an OOM and an unmarked test through an AgentScope override on the layer build.
Resume: ProviderSessionManager test that a session open after an OOM-marked one calls clear before opening (existing
Linux test reused if present).

