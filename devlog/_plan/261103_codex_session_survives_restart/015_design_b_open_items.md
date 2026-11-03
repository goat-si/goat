# 015 — Design B: resolution of the open plan items (input to wp3 P/A; amends 012)

## 1. Guard before any thread request (round-8 "construction hook")
Codex sends thread-scoped server requests only to connections subscribed to that thread
(codex-rs app-server/src/outgoing_message.rs:145-185 ThreadScopedOutgoingMessageSender -> send_request_to_connections(Some(ids))),
and the replay of pending requests happens inside thread/resume for the resuming connection (thread_lifecycle.rs:936-964).
A new socket connection is subscribed to nothing, so no thread-scoped request can reach it before GOAT's first thread/resume for
that thread. Rule: survivor-waiting marks are installed in the Codex session constructor, before the session's first resumeThread;
the adapter's request dispatch checks the mark first. Unscoped requests (send_request with None -> all connections, e.g. account
auth refresh) can arrive at any time; before handlers exist the client already answers methodNotFound (client.ts dispatchRequest
fallback), after they exist the survivor guard answers an error. No protocol pause API is needed.
Test: a fake app-server that replays an approval request in the same tick as the resume response -> answered with an error,
turn/interrupt sent for T, no item emitted.

## 2. Durable process-loss fallback (round-8 new P1)
No in-memory ProviderContinuationRequests. On verified loss while waiting, the adapter emits provider_turn.updated status "failed"
for the survivor provider turn with a dedicated provider failure detail
`codexSurvivorLost: true` carried on the event payload. A GOAT-owned orchestrator rule (new module
orchestration-v2/SurvivorLossContinuation.ts, thin hook where provider-turn failures are decided) writes, in the SAME commit as the
failure events, a provider-runtime.continue effect for the run (stable id effect:survivor-lost:<runId>, idempotent on retry). The
existing RestartContinuation handler then runs today's continuation (chain limit applies; this counts as one link).
Crash before that commit: the run is still running with a running provider turn whose nativeTurnRef = T; startup recovery already
writes a continuation for a running source with a running provider turn (RestartContinuation.ts:170), 009 §1 classifies T's instance
(process gone -> not a survivor), so today's continuation runs. Crash after: the effect is durable. User Stop never sets
codexSurvivorLost. Tests: verified loss -> exactly one continuation effect and one turn/start on a fresh process; crash before commit ->
same outcome through recovery; Stop -> no continuation.

## 3. Durable stop obligation (round-8 #1, #18)
When a release (declined continuation) or a user Stop cannot confirm T ended within its bound, record the obligation in the instance
record: stopObligations: [{threadId, nativeThreadId, nativeTurnId}]. While an obligation exists for a thread, startTurn for that thread
fails with "The Codex turn from before the restart is still running and could not be stopped. GOAT will retry stopping it." and the
session retries turn/interrupt on each new start attempt and on each startup; an observed terminal T clears it. Other threads on the
instance are unaffected. Obligations survive crashes in the record file; startup step 6 (009 §1) also interrupts T as a non-survivor.
The provider turn emits "interrupted" only after native evidence (012 B9).
Test: interrupt timeout -> obligation persisted, next startTurn refused with the message, T ends -> obligation cleared, start succeeds;
crash in between -> obligation still enforced.

## 4. Import consistency without an idle fence (round-8 #14)
T's items are immutable once T is terminal (Codex appends items only to the active turn). Import reads T by id via thread/turns/list /
thread/items/list filtered by T (paged until complete) — it does not require the thread to be idle. A newer native turn (goal) that
starts meanwhile is a different turn: the survivor guard interrupts it and pauses the goal, and nothing from it is imported. The
waiter's single-owner protocol (012 B9) serializes import with Stop, end signals and session loss. Item dedupe against concurrently
running handlers: survivor-waiting threads are excluded from every item handler by the mark checked first in dispatch, so the waiter
is the only emitter of T's items; the mark is cleared only after the import commit.
Test: newer goal turn active during import -> interrupted, goal paused, T's result imported once.

