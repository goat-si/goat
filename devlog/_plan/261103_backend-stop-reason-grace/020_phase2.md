# 020 — wp2: record why and how a backend stopped; give quit/update the full stop budget

Depends on 010. Base origin/dev 21c65d8620. Class: C3 (desktop + server, no wire contract change).
Revision 3. Audit r2/r3 showed that re-implementing the signal escalation in the desktop brings races, platform
differences (Windows taskkill /T /F) and unbounded spawner waits. This revision keeps Effect's escalation
untouched (SIGTERM → forceKillAfter 5 s → SIGKILL → 1 s, NodeChildProcessSpawner.js:356-369) and records only facts the
desktop observes itself: that it asked, why, when, and how and when the process exited. It never claims who sent a signal.

## A. Stop request carries a reason (MODIFY apps/desktop/src/backend/DesktopBackendManager.ts)

- NEW `export type BackendStopReason = "quit" | "update-install" | "recovery-retry" | "recovery-stop" | "instance-closed";`
- `DesktopBackendInstance.stop` (:76) → `(reason: BackendStopReason, options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>`.
  Callers: DesktopApp.ts:161 `stop("quit", { timeout: BACKEND_STOP_TIMEOUT })`; DesktopUpdates.ts:870 `stop("update-install", …)`;
  retry :800 `stop("recovery-retry", { timeout: 10s })`; showRecovery :817 `stop("recovery-stop", { timeout: 10s })`;
  instance finalizer `stop("instance-closed")`; every test/harness caller follows (compile errors are the guard).
- ActiveBackendRun (:102-109) gains `stopRequest: Option.Option<{ reason: BackendStopReason; atNanos: bigint }>`, set with
  `stopRequested` (:705-708) from `Clock.monotonicTimeNanos`; the first request wins.
- stop() writes recordStop INFO "backend stop requested" `pid=<pid> reason=<reason> graceMs=<grace> timeoutMs=<t|none>` when it
  marks a live run, and WARN "backend stop timed out" `pid reason waitedMs; the server may still be running` when closeRun
  returns false (:740-742).

## B. Exit classification in finalizeRun (:455-469)

- Exit time is taken where the exit is observed: `onExitObserved` (DesktopBackendProcess.ts:479-481, before the drain wait) stores
  `exitAtNanos` on the run; elapsed = exitAtNanos − stopRequest.atNanos (both monotonic). The texts report "exit observed <n>ms after
  the stop request"; the stop request precedes onShutdown and the scope close by a bounded in-process step, which the text names
  ("after the stop request", not "after SIGTERM"). The SIGTERM receipt time comes from the server's own line (F) kept in the output (C2).

| stop requested | exit | action | details text |
|---|---|---|---|
| yes | code n, or \`killed by SIGTERM\` | persistStopOutput (C2) | \`pid=<pid> <exit> after stop reason=<reason>; exit observed <n>ms after the stop request\` |
| yes | other signal | persistFailure | \`pid=<pid> killed by <SIG> during stop reason=<reason>; exit observed <n>ms after the stop request (the desktop sends SIGKILL if the server has not exited <grace>ms after SIGTERM)\` |
| no | signal | persistFailure | \`pid=<pid> killed by <SIG>; the desktop had not requested a stop\` |
| no | code n | unchanged | \`pid=<pid> code=<n>\` |

Only observed facts: whether the desktop asked, why, and the elapsed time from the request to the observed exit. The
sender of a signal and whether the escalation fired are not inferred (audit r1#2, r5#2: the spawner's deadline uses
Date.now). \`signalOfExitReason(reason)\` is exported next to the \`killed by\` producer.

## C. Keep shutdown output (MODIFY apps/desktop/src/backend/DesktopBackendProcess.ts)

- Today the stdout/stderr drain fibers are `forkScoped` into the run scope after spawn (:413-428), so a sequential close
  interrupts them before the spawner release signals the server; output written during shutdown is lost (audit r2#2).
- Change: fork the two drains with `Effect.forkDetach` (they end when the pipes close at exit), keep the existing bounded
  await after exit (:482-488), then `Fiber.interrupt` any drain still running; also interrupt them via `Effect.onInterrupt`
  of the program so an interrupted run leaks nothing.

## C2. Shutdown output for every requested stop

- \`DesktopBackendOutputLogShape\` gains \`markStop: Effect.Effect<void>\` and \`persistStopOutput({ details })\`.
  markStop switches the session (one Ref.update) so later chunks go to a separate bounded stop buffer
  (256 KiB: the first 64 KiB after the mark are kept so the SIGTERM receipt survives, then the newest 192 KiB; a dropped middle
  is written as one "… <n> bytes of stop output omitted" record) while earlier chunks stay in the run buffer; eviction in
  either buffer cannot move the boundary (r5#1).
- Stop during startup (r6#1): onStarted's pid update and \`beginSession\` move under the same mutex and pass
  \`stopRequested\` of the run, so a session created after a stop request starts already marked. stop() writes the request
  record for any active run, with \`pid=pending\` when the PID is not known yet.
- stop() calls markStop inside the same \`mutex.withPermits(1)\` block that sets stopRequested (:703-726); finalizeRun takes the
  same mutex (:400), so a finalization can never observe stopRequested without the boundary.
- persistStopOutput writes "backend child process stop output start" / chunks of the stop buffer / "… end" {details}, then clears the
  session. persistFailure on a requested stop writes the run buffer followed by the stop buffer, so a forced stop keeps both.

## D. One owner order for instance teardown (row 7a)

- The instance owns `runsScope = yield* Scope.make("sequential")`; program forks (:620) and closeRun's fork (:161) use it.
  The instance's single finalizer is `stop("instance-closed").pipe(Effect.ensuring(Scope.close(runsScope, Exit.void)))`,
  so the stop is requested and recorded before any run fiber is interrupted, whatever the parent scope's strategy (r2#3, r3 accepted).
  Restart and recovery forks stay in parentScope (stop() already interrupts the restart fiber).

## E. Stop budget

- `export const BACKEND_STOP_TIMEOUT = Duration.sum(DEFAULT_BACKEND_TERMINATE_GRACE, Duration.seconds(2))` in DesktopBackendProcess.ts
  (comment: grace, SIGKILL and its 1 s exit wait, plus margin). Used by quit and update. A margin, not a guarantee: the overrun case
  is recorded by "backend stop timed out". Output drain after exit is bounded separately (existing 5 s, normally immediate at pipe EOF); a drain that hits the bound is part
  of what "backend stop timed out" can report.
  The 5 s grace itself is unchanged: no over-grace phase is measured (010 §4; loaded gate in F).

## F. Server shutdown timeline (MODIFY apps/server/src/cli/server.ts, apps/server/src/serverRuntimeStartup.ts)

- cli/server.ts in the Effect.scoped (:64): scoped SIGTERM/SIGINT listeners logging `Server received <SIG>; shutting down`
  at receipt (removed on release); `Effect.onExit` around the raced `run` logs `Server shutdown finished` {exit, totalMs}
  with Clock.monotonicTimeNanos from the signal when one was received.
- serverRuntimeStartup.ts finalizer (:541-571): `timedShutdownPhase(name, effect)` logs "Server shutdown phase started" {phase}
  and "Server shutdown phase finished" {phase, durationMs, outcome} around effect-worker interrupt, prepareForShutdown,
  providerSessions.shutdown, reconcile. A phase still running at SIGKILL is the last "started" without "finished".
- REQUIRED C gate: loaded measurement on a dev server in this worktree (≥3 Replay (dev) turns in flight, ≥3 terminals), SIGTERM by
  captured PID; transcript of phase lines and exit time. A phase over grace gets its own failing test and fix in this unit.

## G. Log writer (MODIFY apps/desktop/src/app/DesktopObservability.ts)

- `DesktopBackendOutputLogShape` (:52-61) gains `recordStop({ message, level: "INFO" | "WARN" | "ERROR", details })`: one
  `writeBackendChildLogRecord` (component desktop-backend-child, runId, instanceId, phase "STOP"); session untouched.
  Extend the level union at :403 with "WARN". Noop (:139-143) and stubs (DesktopBackendManager.test.ts:126, DesktopBackendPool.test.ts:43, others) add it.

## Tests (failing-first on base, existing files, TestClock/Deferred/Queue; no sleeps)

DesktopBackendManager.test.ts (fake spawner whose release finalizer takes a Deferred-controlled time and then completes exit):
1. "a backend still running after the grace is recorded with its stop reason and output": stop("quit", {timeout: BACKEND_STOP_TIMEOUT});
   TestClock.adjust past grace; complete exit as SIGKILL → one persistFailure with "during stop reason=quit" and the elapsed ms;
   recordStop "backend stop requested". Base: discardSession, nothing persisted → fails.
2. "a requested stop that exits cleanly keeps its shutdown timeline": after stop() the fake server prints "Server received SIGTERM", a phase line and "Server shutdown finished"; exit 0 → persistStopOutput with reason=recovery-stop containing exactly those lines.
3. "stop output keeps its first and newest lines when it overflows": pre-stop output fills the run buffer past its cap, then post-stop output
   exceeds 256 KiB → persisted block has the first post-stop line, the omitted-bytes record, and the last line, in order; pre-stop eviction does not move the boundary.
3b. "a stop requested before the process reports its pid still marks the output": spawn waits on a Deferred; stop("quit"); release the
   Deferred; the child prints a line and exits 0 → request record with pid=pending and the line in the stop block.
4. "a SIGKILL without a stop request says so": → "the desktop had not requested a stop". Base: "pid=123 killed by SIGKILL" → fails.
5. "closing the instance's scope stops the run through stop()": close the owning scope (primary-style and Scope.fork(…,"sequential") WSL-style)
   → "backend stop requested reason=instance-closed". Base: run interrupted, nothing recorded → fails.
6. "stop with a timeout equal to the grace records that it gave up": → "backend stop timed out".
7. "output written after the stop begins reaches the persisted session": stdout Queue emits a line after release starts; exit SIGKILL past grace →
   writeOutputChunk received the line before persistFailure. Base: drain interrupted → fails.
DesktopBackendProcess.test.ts (NEW, it.live, real NodeChildProcessSpawner; the fixture is the only subprocess case):
9. a node child that logs on SIGTERM, ignores it, and keeps running; runBackendProcess with forceKillAfter overridden to 200 ms (new
   option terminateGrace, default the constant); closing the scope → exit reason "killed by SIGKILL" and onOutput received the
   post-SIGTERM line before runBackendProcess returned. Base: drains interrupted, line missing → fails.
10. a child that exits 0 on SIGTERM → exit reason "code=0" and its shutdown line reached onOutput.
serverRuntimeStartup.test.ts:
8. providerSessions.shutdown taking 3 s on TestClock → "Server shutdown phase finished" {phase:"providerSessions", durationMs:3000}.

## Verification

- `vp test run` on touched test files; `vp run check:changed` exit 0 when host.status is not critical.
- Runtime: idle + loaded SIGTERM transcripts on the worktree dev server (server phase lines). No app restart, no live state.
- No UI change → no screenshots.

## Risks

- Required `reason` touches every caller (intended). persistFailure on abnormal stops writes up to 1 MiB (rotating log).
- Windows: the spawner force-terminates (taskkill /T /F); records then show the exit code and elapsed without signal names, which is accurate.

