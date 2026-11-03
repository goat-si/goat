# 007 — Revision R2: fold of audit round 2 (VERDICT FAIL; 1 resolved, 7 partial, 2 new P1)

Overrides 006 where they conflict. Direction change (LOOP-PESSIMIST): R1 tried to recover every state of a surviving turn. R2 narrows v1
to ONE safe case and fails closed everywhere else. What died: "adopt any surviving turn". What would refute R2: a plain turn whose
adoption still loses or duplicates output in the c-2 harness.

## G. Adoption gate (answers R2 #2, #4 and part of #1)
Adopt T only if ALL hold at reattach, read from thread/read (includeTurns) + thread status after the continuation's resumeThread:
1. survivor identity proven: source run's latest provider turn has nativeTurnRef === T.id (derived from the projection, see D) and
   the thread's latest native turn is T;
2. thread status is idle, or active with activeFlags = [] (no waitingOnApproval / waitingOnUserInput — this catches requests raised
   while GOAT was down; ServerNotification__ThreadActiveFlag, schema.gen.ts:2185);
3. no active goal on the native thread (thread/goal/get or the resume goal snapshot);
4. T contains no collabAgentToolCall item with tool spawnAgent (no native subagents to mirror).
Gate fails or any read fails -> STOP path: turn/interrupt T, then wait for T's terminal status from the snapshot/notification
(bounded; TestClock in tests); proven stopped (interrupted/completed/failed) -> existing continuation path (turn/start) unchanged;
not proven within the bound -> fail the continuation run with "Codex turn from before the restart could not be stopped" and send no
turn/start. A continuation that RestartContinuation declines also takes the STOP path for its survivor (interrupt only).
Native turns on the process with no survivor (no owning run) -> interrupt at attach (same policy as the orphan goal handler).

## D. Survivors are derived, never stored as mutable ledger state (answers new P1 "ledger durability", #1)
At each startup, survivors(instance) = runs whose continuation effect is pending in the outbox after recover() AND whose provider
turn has a nativeTurnRef. An adopted turn records a provider turn with the same nativeTurnRef (distinct providerTurnId, A1), so after a
second crash the continuation-of-continuation derives the same T. Nothing between dispatch, registration and adoption needs a ledger
write; in-memory claim state is rebuilt from the projection on every start. The record file holds only process ownership
(pid, pgid, socketPath, unit, fingerprint, state: spawning|running|terminating). Sweep runs only if derivation completed; any
projection/outbox read failure -> no sweep this start (log).
Release executor (#1): CodexSurvivors.release(threadId, sourceRunId) attaches a short-lived control connection when no session is
attached (connect, initialize, turn/interrupt, close) — no dependency on a later session open. Termination when zero survivors remain
unsettled and no session is attached.

## H. Handoff without permit deadlock (answers new P1 "permit deadlock", #3)
Never hold turnTerminalizationPermit across an RPC, and never call handlers while holding it.
1. Short permit section: registerRootTurn(T, distinct providerTurnId) + context.seenNativeItemIds = new Set(). Release.
2. RPC thread/read without the permit. Live notifications meanwhile route to the context and add to seenNativeItemIds.
3. Replay: for each completed item in the snapshot not in seenNativeItemIds and not KNOWN-COMPLETED in the projection, call the same
   function the item/completed notification handler calls (it takes the permit itself). Items GOAT knows only as incomplete (e.g. an
   agent message frozen as non-streaming by recovery, ProviderRuntimeRecoveryService.ts:532-545) ARE replayed with final content: they
   move to the continuation run, where they finished. knownCompletedNativeItemIds comes from RestartContinuation's projection read.
4. If the snapshot shows T finished and the context is still registered: call the turn/completed handler function (it takes the
   permit; idempotent when a live completion already removed the context).
Tests: notification queued before the read response (protocol reader serial, protocol.ts:367-419); completion before registration;
completion during the read; item seen live and in snapshot emitted once; streamed message frozen by recovery completes with full text.

## L. Linux identity (answers #6)
Anchor: packages/shared/src/AgentScope.ts:84 "Exec at every step preserves the agent PID" (/bin/sh -c LAUNCH_SCRIPT / SCOPED_LAUNCH_SCRIPT
exec chain, :86-110). Wrapped (systemd scope): record the unit name; terminate with systemctl --user kill --signal=SIGTERM <unit>
then SIGKILL (AgentScope already shells systemctl for kill, apps/server/src/process/agentScope.ts:368-378). Unwrapped: pgid path.
Identity check on Linux reads /proc; any unreadable field -> unverifiable (keep record, no signal). Linux runtime behavior is NOT RUN on
this macOS host; the PR states it and CI Linux unit tests cover the decision logic with a fake process table.

## B. Shutdown budget (answers #5)
Additions on the shutdown path are: one record write per detached instance and, for unretained instances, a non-waiting group
SIGTERM. Test with TestClock: shutdown with N detached instances adds no awaited delay (no Clock advance needed for finalizers to
finish). The overall 5 s budget work belongs to thread 3's PR #2418; this PR rebases on it.

## T. Transport fixture (answers #7)
Fragmentation test uses a raw net server on a temp UDS that performs the WebSocket handshake with ws.WebSocketServer({noServer:true})
and inspects frames via a 'upgrade' + receiver hook, or a hand-rolled frame reader on the raw socket, asserting FIN=0 frames > 1 for
a 20 MB message. Physical path: Codex places the socket at /tmp/codex-daemon-<uid>/<64 hex> (001 A): length check covers both the alias
we choose and that resolved path (<= 103 bytes) before spawn; else stdio fallback with a logged reason.

## C. Proof additions (answers #8)
Integration (c-2/c-3 harness): two consecutive restarts with T still running (adopted twice, chain counts); crash between spawn and
record pid write (spawning record kept, no signal); two threads on one instance, one adopted and one declined (declined interrupted,
adopted unaffected, process kept); request raised while disconnected (activeFlags) -> STOP path.

