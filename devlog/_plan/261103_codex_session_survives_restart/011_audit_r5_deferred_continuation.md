# 010b — Revision R5: "deferred continuation" (supersedes 009 §2-§3; keeps 009 §1 startup phase)

## Why
Round 5 (on 009) found that waiting inside startTurn blocks the thread's effect lane (ProviderTurnStartService.ts:1371 awaits
session.startTurn; EffectOutbox.ts:381 serializes the lane; Stop/Steer are effects, EffectWorker.ts:171), that resumeThread runs
before startTurn (ProviderTurnStartService.ts:1002), and that a run waiting with no provider turn is not recoverable after a second
crash (RestartContinuation.ts:170). Dead hypothesis: "a GOAT run waits for the surviving turn". New: NO GOAT run exists while the
surviving turn runs; the durable pending continuation effect is the only marker; it is dispatched when the turn has ended.

## Model
- While T runs after a restart, the thread has the source run (terminalized by recovery as today) and a pending
  provider-runtime.continue effect that is deferred. The agent keeps working inside Codex; GOAT shows no running run (known v1 limit,
  documented; not worse than today, where T is dead).
- When T ends (completed, interrupted, failed) the effect becomes available and today's continuation runs unchanged: a new run,
  resumeThread on an idle native thread, turn/start with today's continuation prompt. The agent sees T's completed work in its
  history. No live binding, no import, no replay (A1 and item filters are dropped).
- Fail closed everywhere: anything GOAT cannot own is interrupted, or the process is terminated -> exactly today's behavior.

## 1. Deferral (RestartContinuation.ts + EffectWorker.ts + EffectOutbox.ts)
- continueRestartedRun: after its existing decline checks pass and BEFORE creating the continuation run, ask
  CodexSurvivors.status(threadId, sourceRunId): "running" -> fail with new tagged RestartContinuationDeferred({retryAfterMs}).
  "ended" | "none" -> proceed exactly as today. Declines -> CodexSurvivors.release(threadId, sourceRunId) (interrupt T) then decline.
- EffectWorker (provider-runtime.continue case, :93 and the retry decision near :823): RestartContinuationDeferred ->
  outbox.retry({delayMs: retryAfterMs, undoAttempt: true}) — durable, not counted against maxAttempts.
- EffectOutbox claim predicate (:381-395): a pending provider-runtime.continue whose available_at > now does not block later effects
  of its thread (new clause). So a user message during the wait proceeds at once.
- CodexSurvivors wakes the effect (set available_at = now via a new EffectOutbox.wake(effectId)) when T is observed terminal, so the
  delay is only a safety net (retryAfterMs = 30 s; TestClock in tests).
- Second crash during the wait: the effect is still pending -> 009 §1 re-derives the survivor through the source run (unchanged:
  no continuation run or provider turn was created). Durable by construction.

## 2. Watching T (CodexSurvivors, apps/server/src/provider/CodexSurvivors.ts)
- 009 §1 startup phase keeps ONE control connection per instance with survivors (one extra UDS fd per instance, not per agent).
  Handlers are installed before it calls thread/resume on each survivor's native thread (subscribe):
  - turn/completed for T or thread/status/changed to idle -> re-read with thread/read; T terminal -> mark ended, wake effect.
  - ANY server request on this control connection (thread-scoped, replayed after resume per thread_lifecycle.rs:936-964, or unscoped
    such as account auth refresh, external_auth.rs:33) -> answer JSON-RPC error "GOAT restarted; this request was cancelled";
    if thread-scoped -> turn/interrupt T. Requests not replayed by Codex (connection-owned verification) were cancelled by Codex
    when the old connection closed (user_verification_ownership_tests.rs:83) and surface as T failing -> ended.
  - A new native turn started on a survivor thread while watching (goal) -> turn/interrupt + thread/goal/set paused.
- Close the control connection when no survivor of the instance is still running.

## 3. New user work during the wait (CodexAdapterV2 thin hook in startNativeTurn, before turn/start)
If CodexSurvivors.status(nativeThread) === "running": turn/interrupt T, await T terminal through the survivor watcher (bounded,
Clock; timeout -> fail this turn start with "the turn from before the restart could not be stopped", no turn/start), then turn/start.
This prevents Codex from folding the user's input into T and the existing #489 path from binding T to the new run. The deferred
continuation then sees newer user work and declines (existing rule) -> release is a no-op (T ended).

## 4. Retention and termination
Shutdown: retain an instance if prepareForShutdown recorded a continuation for one of its threads OR it has a running survivor
(deferred continuation), subject to the stop-intent/setting rule. Termination when no survivor is running and no session attached
(the continuation's own session open attaches the process like any shared session). Serialization per 009 §3.

## 5. Proof
c-2 (orchestrator harness, fails on dev): (a) T running at shutdown, completes after restart -> continuation run starts only after
T completed (fake records turn/start strictly after T's turn/completed), and no turn/start reached the fake while T ran; the native
thread shows one completed T and one continuation turn; (b) T completes while no server runs -> continuation runs at once;
(c) crash during the deferral -> second start re-derives and still defers; (d) a user message during the deferral interrupts T,
runs the user's turn, and the continuation declines.
c-3: process gone / identity mismatch / fingerprint change / enumeration failure -> today's continuation (turn/start) with no
deferral; a request replayed on the control connection -> answered with an error, T interrupted, continuation proceeds; deferred
continuation does not block a later effect of the same thread (outbox unit test).
c-4: ownership/identity/termination unit tests (020 + 007 L + 008 U).
Transport: 010 + 006/007 T.

