# 010 — wp1 investigation: who stops the backend, and what shutdown waits for

Base: origin/dev 21c65d8620. All anchors are in this worktree.

## 1. What the 10-30 record proves

- server-child.log only receives a session when `backendOutputLog.persistFailure` runs.
  `finalizeRun` calls it only when `exitObserved && !stopRequested`
  (apps/desktop/src/backend/DesktopBackendManager.ts:462-468); every desktop-requested stop
  calls `discardSession` instead (:467).
- `stopRequested` is set only by `stop()` (DesktopBackendManager.ts:705-708), which every
  desktop stop path goes through (inventory below).
- How the desktop can terminate a live backend: only by closing the run scope while the process is
  alive. That happens (a) in \`stop()\` via closeRun (DesktopBackendManager.ts:145-166, sets stopRequested first) or
  (b) when the program fiber is interrupted, whose \`Effect.ensuring(Scope.close(runScope))\` (:617) then runs the
  spawner release and its SIGTERM→SIGKILL escalation (NodeChildProcessSpawner.js:407-418, 356-369). In (b)
  \`Effect.matchEffect\` (:613-616) never runs, so finalizeRun/persistFailure do not run either. After the leader has exited, the release
  signals the remaining group only on a nonzero code, or when the handle is referenced, non-Windows and not
  `detached:false` (:410-418); either way the leader is already gone.
- Therefore the 10-30 block (\`phase:END details:"pid=32846 killed by SIGKILL"\`, log line 258) belongs to a run
  that exited by SIGKILL while no desktop stop was requested and the program fiber was not interrupted: the desktop's
  own escalation did not end that process. Last server output 23:45:16.120; exit observed by 23:45:17.295. The
  timing does not exclude an earlier SIGTERM from another sender.
- Retained evidence cannot name the sender: desktop.trace.ndjson rotated (oldest 11-02 21:02),
  `log show` for 23:44:30–23:45:30 returns no jetsam/kill entries, and Codex/Claude session logs for
  14:42–14:46Z contain no kill/pkill/killall tool calls. Status: **no desktop stop recorded; SIGKILL sender unknown** (not the desktop's stop or run-scope teardown).
- Candidates checked and excluded in current code: StrayProcesses only targets PID-1 orphans whose
  home is deleted or temporary (apps/server/src/diagnostics/StrayProcesses.ts:83-101); the Claude
  group-kill fallback `signalProcessGroup(child.pid ?? 0, …)` (ClaudeAdapterV2.ts:404) is guarded by
  `pid <= 1` → ESRCH (packages/provider-core/src/server/processGroup.ts:3); AgentScope kill is
  Linux/systemd only (apps/server/src/process/agentScope.ts:349-380).
- Gap that made this ambiguous: the log never states whether the desktop requested a stop, so a
  reader cannot tell "desktop forced it after grace" from "something else killed it".

## 2. Every desktop path that stops a backend

| # | Trigger | Call site | Budget | Reason logged today |
|---|---------|-----------|--------|---------------------|
| 1 | App quit (scope finalizer) | apps/desktop/src/app/DesktopApp.ts:155-163, :359-364 | stop({timeout:5s}) | none (desktop.lifecycle logs quit, not the backend stop) |
| 2 | Update install (quitAndInstall) | apps/desktop/src/updates/DesktopUpdates.ts:862-872 | stop({timeout:5s}) | none |
| 3 | Recovery dialog "Retry" | DesktopBackendManager.ts:797-807 (retry → stop) | 10 s | none |
| 4 | Recovery dialog "Stop" | DesktopBackendManager.ts:808-820 (actions.stop), DesktopBackendRecoveryDialog.ts:36 | 10 s | none |
| 5 | Instance scope closed (pool layer teardown, WSL unregister) | DesktopBackendManager.ts:822 `addFinalizer(() => stop())`; DesktopBackendPool.ts:322-325; apps/desktop/src/wsl/DesktopWslBackend.ts:82 | unbounded | none |
| 6 | Settings that relaunch the app (server exposure, WSL, local environment, window material, CUA grants) | apps/desktop/src/ipc/methods/{serverExposure.ts:38,53, wsl.ts:66,88,107, localEnvironment.ts:27,53, windowMaterial.ts:34, cua.ts:72} → DesktopLifecycle.relaunch (DesktopLifecycle.ts:255-268) → quit path #1 | as #1 | desktop.lifecycle logs "desktop relaunch requested" {reason} to desktop.trace only (rotates within ~1 h) |
| 7a | Instance scope closed while a run is active (WSL unregister, pool layer teardown) | with a sequential parent (WSL instances, DesktopBackendPool.ts:248) finalizers run LIFO and the program fiber forked at :620 is interrupted before the stop finalizer registered at :822; with a parallel parent the order is undefined, so the ensuring close (:617) kills the server with no stopRequested and no record | unbounded | **none — gap** |
| 7b | Repeated Quit / SIGTERM to the desktop after the 10 s stall | DesktopLifecycle.ts:118-139 \`electronApp.exit(0)\` | — | desktop.lifecycle error to desktop.trace only |
| 7 | Crash detection / restart | finalizeRun → scheduleRestart (DesktopBackendManager.ts:476-487, :629-697); the backend already exited, nothing is stopped | — | exit reason persisted (failure session) |

Stop mechanics: `stop()` marks `stopRequested`, closes the run scope (closeRun,
DesktopBackendManager.ts:145-166); the child-process finalizer sends SIGTERM to the process group,
waits `forceKillAfter` (5 s), sends SIGKILL, then waits up to 1 s more (POSIX; on Windows every step is `taskkill /T /F`, NodeChildProcessSpawner.js:55, 296-305)
(node_modules/@effect/platform-node-shared/dist/NodeChildProcessSpawner.js:356-369,
processGroupGraceMillis = 1_000 at :30).

## 3. Risk found: quit/update stop the wait at the moment SIGKILL is due

Paths #1/#2 pass `timeout: 5s`, equal to the grace. closeRun returns `false` after 5 s
(DesktopBackendManager.ts:161-165) while the escalation fiber is still at the SIGKILL step; the app
then marks shutdown complete and quits; whether the forked close finishes before the Electron process exits is
not guaranteed (DesktopApp.ts:359 notes quit can outrun layer finalizers). A server still draining at 5 s may be
neither killed nor recorded (risk, not reproduced). The spawner's wait after SIGKILL is unbounded once the 1 s grace
ends (:368 \`Deferred.await(exitSignal)\`), so 7 s is a margin that covers the normal escalation, not a guarantee.
DesktopLifecycle.ts:108-111 already assumes a stop budget of "SIGTERM, 5s grace, SIGKILL, 1s wait"
(stall threshold 10 s), so the callers disagree with the lifecycle's own model.

## 4. What the server's SIGTERM shutdown waits for

- Entry: NodeRuntime.runMain interrupts the main fiber (apps/server/src/binCli.ts:152); the desktop
  launcher-loss race ends the same way (apps/server/src/cli/server.ts:83-90).
- Main finalizer (apps/server/src/serverRuntimeStartup.ts:541-571): fail command gate → interrupt
  effect worker → `providerRuntimeRecovery.prepareForShutdown` → `providerSessions.shutdown`
  (releases all sessions in parallel, ProviderSessionManager.ts:2504-2529, documented as fitting the
  launcher's 5 s deadline with ≤15 sessions) → `reconcile("shutdown")` → log
  "V2 orchestration shutdown reconciliation completed".
- Other bounded waits: terminal kill escalation 1 s grace per PTY (apps/server/src/terminal/Manager.ts:134,
  :1353-1411), HTTP preemptive shutdown grace (apps/server/src/server.ts:282, :412).
- No log marks SIGTERM receipt or phase durations, so a slow phase cannot be named from server-child.log.
- Measurement (dev server in this worktree, seeded `.goat`, PID 79139 confirmed by cwd, idle):
  SIGTERM 07:00:51.047 → reconciliation log 07:00:51.064 → exit after **0.116 s**
  (/tmp/stopreason/dev1.log, /tmp/stopreason/term.py). An idle server is far inside the grace;
  no phase is measured over grace. A loaded measurement (Replay sessions + terminals) is a C-phase
  item for wp2 once timing logs exist.

## 5. Conclusion for wp2

1. Record stop reason, SIGTERM time, elapsed and outcome in server-child.log for every requested stop;
   mark unrequested signal exits as external; persist the captured output when the desktop forced SIGKILL.
2. Give quit/update stops the full escalation budget (5 s + SIGKILL + 1 s wait + margin) so a slow
   server is killed and recorded instead of orphaned. The grace itself stays 5 s (no measured need).
3. Server logs SIGTERM receipt and per-phase shutdown durations so the next slow stop names its phase.

