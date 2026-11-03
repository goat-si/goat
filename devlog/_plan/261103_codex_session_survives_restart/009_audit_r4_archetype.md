# 009 — Revision R4: archetype change "wait, then import" (supersedes adoption in 030 §4, 006, 007 G/H/O, 008 S/O/N/R)

## Why (LOOP-DOOM / LOOP-PESSIMIST)
Rounds 1-4 FAILed on the same root: binding a still-running native turn to a new run while its events stream (replay vs live dedupe,
deferred completion, request replay barrier, subagent ancestry, permit re-entry). Each fold surfaced a finer race. Dead hypothesis:
"adopt a live turn and stream the rest". New hypothesis: never bind a live turn. The surviving turn runs to its end inside Codex;
GOAT only (a) stops what it cannot own, (b) waits, (c) imports a FINISHED turn while the thread is idle. What would refute it: a
finished turn whose import still races Codex (thread not idle), or a waiting turn that can block forever.
Cost accepted for v1: the remainder of a surviving turn after the restart is not streamed; it appears when the turn finishes. The
continuation run shows as running meanwhile (truthful: the agent is working).

Kept from earlier docs: 010 transport (+006/007 T hardening), 020 process ownership (+007 L, 008 U identity), stop intent (030 §1),
retention decision (030 §2), settings, MCP wording (006 §MCP), A1 distinct providerTurnId for an imported turn, known-completed filter.

## 1. Startup phase "codex.survivors" (inside runOrderedV2StartupPhases after recover, before startEffectWorker)
For each instance record (fail closed at every step; "terminate" = verified-group termination per 020/007 L/008 U; if identity is not
verified, never signal — use the socket instead and keep the record as a reported stray):
1. connect the socket and initialize a CONTROL connection. Fail -> process unusable: terminate if verified (else stray). Its threads'
   continuations run today's path (no live process).
2. fingerprint differs from the current launch -> interrupt all active turns over the socket, then terminate. (Settings changed while down.)
3. candidates = threads of this instance with a pending provider-runtime.continue effect; for each, T = latest Codex nativeTurnRef
   found walking source run -> restartContinuationOfRunId ancestry (008 I). No T -> not a candidate.
4. enumerate loaded threads (thread/loaded/list, all pages) and thread/read each (status, activeFlags, turns tail, parentThreadId,
   goal via thread/goal/get). Any enumeration/read failure -> interrupt everything readable, then terminate (or stray) — today's world.
5. survivor = candidate whose native thread's latest turn is T, T is inProgress or finished after the source run's provider turn
   started, activeFlags == [], no active goal. Subagent threads: a loaded thread whose parentThreadId chain reaches a survivor's
   native thread belongs to that survivor and is left alone; chain unreadable -> its root is not a survivor.
6. interrupt every active native turn that is neither a survivor's T nor a descendant of a survivor (blocked runs with no
   continuation effect, gate failures, orphans, goal turns). Await terminal status per thread, bounded (Clock; TestClock in tests);
   timeout -> terminate the process (verified) — today's world.
7. survivors == {} -> terminate (verified) or leave idle stray. Else keep; publish survivors (threadId -> {nativeThreadId, T}) to
   CodexSurvivors (in memory; re-derived every start, no ledger file). Close the control connection.

## 2. Continuation with a survivor (Codex adapter startTurn hook, module Adapters/CodexSurvivorContinuation.ts)
Precondition: CodexSurvivors.take(threadId, sourceRunId) returns {nativeThreadId, T}; the session attached the retained process.
1. Register a waiter for T on this session BEFORE subscribing: resolves on turn/completed for T or thread/status/changed to idle.
   Mark the native thread "survivor-waiting": the adapter's turn/started/item handlers ignore its notifications (no orphan-goal
   pause, no item emission) — nothing streams.
2. thread/resume (subscribes). Codex may re-send pending server requests after the resume response (thread_lifecycle.rs:936-964).
   ANY server request for this native thread or a descendant while survivor-waiting -> answer JSON-RPC error
   ("GOAT restarted; this request was cancelled"), turn/interrupt T, continue at step 4 with T interrupted.
3. thread/read: if T already finished, resolve the waiter.
4. On T terminal (read with thread/read once the waiter resolves; the thread is idle now):
   - completed: import. Register a context for T with a distinct providerTurnId (A1), emit started, convert each completed item
     NOT known-completed in the projection (known-incomplete ones are re-emitted with final content) through the existing item
     conversion; skip collabAgentToolCall/subAgentActivity items (subagent progress is not mirrored); emit provider turn completed
     with T's status. No turn/start. The thread is idle and survivor-waiting is cleared only after import, so no live event can race.
   - interrupted or failed: clear survivor-waiting, then the existing startNativeTurn path (today's continuation prompt).
5. Steer while waiting -> interrupt T, await terminal, then the existing startNativeTurn with the steer as the prompt.
   Stop while waiting -> interrupt T; the run ends as interrupted.
6. If a NEW turn starts on the native thread while survivor-waiting (only possible from Codex itself, e.g. a goal) -> interrupt it and
   pause the goal (existing orphan policy), then proceed.
Waiting is bounded only by the turn itself; it never blocks forever on GOAT-side input because every request fails closed (2) and
the user can stop/steer (5).

## 3. Declined continuations and last-survivor termination
RestartContinuation declining (blocked, archived, user stop, chain limit, setting off) calls CodexSurvivors.release(threadId,
sourceRunId): interrupt T over the session or a control connection, await terminal (bounded). Failure -> keep the process, log; next
start re-derives. Serialization: one Semaphore per instance around take/release/terminate decisions; interrupt waits happen
outside the lock. Terminate the process when no survivor is pending/waiting and no session is attached.

## 4. Proof (c-2/c-3/c-4), orchestrator-level harness with a fake app-server whose state outlives runtime 1
c-2 (fails on dev): (a) T running at shutdown, completes after restart -> continuation run completes with T's final message,
zero turn/start; (b) T completes while no server runs -> same; (c) two restarts while T runs -> still one result, chain counted.
c-3: (a) retained process gone / identity mismatch -> today's continuation; (b) server request replayed after resume -> request
answered with error, T interrupted, today's continuation; (c) active goal or activeFlags at startup -> interrupted at startup;
(d) blocked run on the same instance as a survivor -> its turn interrupted, survivor unaffected; (e) T interrupted while waiting ->
today's continuation; (f) enumeration failure -> process terminated.
c-4: unit tests of record/identity/termination (020 + 007 L + 008 U) incl. unverifiable -> no signal, stray kept.
Import tests: known-completed items not moved; frozen partial message completes with full text; subagent items skipped.

