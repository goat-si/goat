# 012 — Design B (orchestrator decision 2026-11-03): visible waiting run, import at the end
Supersedes 009 §2-§3 and 011. Keeps: 010 transport (+006/007 T), 020 ownership (+007 L, 008 U), stop intent (030 §1), settings,
MCP wording (006), 009 §1 startup phase (amended below), A1 distinct providerTurnId, known-completed filter.

## Orchestrator conditions
(1) truthful state through contracts on web/desktop/mobile ("turn started before the restart is still running; its progress appears
when it finishes"); (2) Stop stops the real native turn, confirmed by an event; (3) a silently dead or unreachable process falls back to
today's continuation after a bounded time, and the same turn never runs twice (test); (4) PR body states why live rebinding was
excluded; PRs may be split.

## PR split
- PR-A (wp1+wp2): message-channel transport, UDS connector, detached launcher, ownership records, verified termination, setting.
  No survival yet: shutdown terminates detached processes as today; the startup phase terminates every surviving record (crash
  leftovers). Behavior equals today except where the app-server runs. Safe to merge alone.
- PR-B (wp3+wp4): survival per this document, contracts field, client labels, docs.

## B1. Contract (packages/contracts/src/orchestrationV2.ts, OrchestrationV2ProviderTurn ~:1199)
`survivingRestart: Schema.optional(Schema.Struct({ nativeStartedAt: Schema.NullOr(Schema.DateTimeUtc) }))` on the provider turn.
Present only while the turn is a survivor being waited on; cleared (field absent) when the turn is imported or stopped.
packages/client-runtime: one derivation `survivingRestartNotice(providerTurn)` returning the label text; web (working indicator of the
run) and mobile (same component family) render it. Desktop = web. The label: "Running since before the server restarted. Progress
shows when this turn finishes." No spinner pretending streaming: the existing working indicator plus this text.

## B2. Startup (009 §1, amended)
Steps 1-7 stand, with these changes (round-6 #2, #1):
- An instance whose process cannot be verified AND cannot be reached on its socket is "unknown": its candidates are NOT survivors and
  their continuations are held (B6) until the process is proven gone (no pid) or reachable; never start a replacement turn while the
  old turn may still run. Bounded: after FALLBACK_AFTER (5 min, config, TestClock in tests) the hold ends only if the pid is gone or
  identity mismatch proves reuse; otherwise the continuation fails with a visible error ("could not confirm the previous Codex
  process stopped") — no turn/start.
- Survivor set is published to CodexSurvivors in memory; the startup phase closes its control connection after interrupts (no long-
  lived watcher: the waiting run's own session watches, B3).

## B3. Continuation with a survivor (no lane blocking; round-5 P1s)
Session open for the instance (factory attach) receives the survivor set BEFORE any resumeThread: the adapter marks those native
threads survivor-waiting, so its notification handlers ignore them and its server-request handlers fail closed for them (answer
error + turn/interrupt T) from the first message of the connection (round-5 "waiter too late", round-6 #12).
startTurn for a continuation whose survivor is T (identity by ancestry, 008 I):
1. short permit section: create the context for T with a distinct providerTurnId (A1), status running, survivingRestart set,
   reconciling=true; emit provider_turn.updated (running). This persists the provider turn with nativeTurnRef=T, so a second crash
   re-derives T through the continuation run itself (round-5 "second crash").
2. register the end waiter (turn/completed for T, thread/status/changed idle), then thread/read once (T may already be terminal).
3. return from startTurn immediately (round-5 lane P1). The waiter is a supervised fiber in the session scope.
4. on end: B4. Notifications for T other than the end signal are ignored while waiting (no streaming; condition 1).

## B4. Import at the end (round-5 "idle/complete" P1)
Re-read: thread/read includeTurns. Require: T status terminal; thread status idle (if a new native turn is active — goal — interrupt
it and pause the goal, then re-read, at most once more); T's itemsView is full; if not, page thread/items/list for T until complete.
Then emit T's completed items not known-completed (known-incomplete re-emitted with final content; collab/subAgentActivity skipped),
clear survivingRestart, and terminalize the provider turn with T's status through the existing completion function. completed ->
run completes; interrupted/failed -> run ends like any interrupted/failed turn (today's handling, which may queue a continuation
per existing rules — chain limit applies). Any read failure -> provider turn failed with "Could not read the result of the turn
that ran across the restart"; no turn/start (condition 3: never run twice).

## B5. Stop and Steer (condition 2)
- Stop on the run -> adapter interruptTurn for the survivor providerTurnId -> turn/interrupt T on the native thread -> the end waiter
  observes turn/completed(interrupted) -> B4 import -> provider turn interrupted event = confirmation. If no end within STOP_CONFIRM
  (10 s, the adapter's existing confirm window) the existing Force stop path applies: Force stop terminates the instance process
  only if no other survivor or live run uses it; otherwise it reports that the shared Codex process could not be stopped without
  stopping other threads (no silent success).
- Steer -> interrupt T, await end + import, then start a normal turn with the steer input (supportsSteeringByInterruptRestart path).

## B6. Silent death / unreachable (condition 3)
- The waiting session's client terminates (socket closed / process exited): every waiting survivor on that instance ends its
  provider turn as interrupted with terminationCause "codex-process-lost" and the existing restart-continuation rule queues today's
  continuation; the new continuation spawns a fresh app-server (record gone or process verified dead). T cannot run twice: the only
  process that held T is dead (verified pid gone) before turn/start runs on the new process; if death cannot be verified, B2's
  unknown-instance hold applies.
- Waiter liveness: if no message arrives on the connection for HEARTBEAT (60 s), send thread/read; failure -> treat as lost (above).
- Test: process killed during wait -> continuation spawns fresh, the fake records T only on the dead process and one new turn on
  the new process; unreachable-but-alive (identity unverifiable) -> no new turn until proven, then fallback or visible error.

## B7. Declines and unscoped requests (round-6 #1, #4)
- Declined continuation (blocked, archived, chain limit, setting off) -> CodexSurvivors.release: interrupt T (session or a short control
  connection) and await end; failure -> durable "stop pending" is the still-pending decline: the effect retries (existing outbox retry)
  until T is confirmed ended or the process is gone, never dropping the obligation across crashes.
- Unscoped server requests (account auth refresh) on a connection with waiting survivors -> answer error; T continues; if T then
  fails, B4 handles it. No wait depends on an unscoped request.

## B8. Proof (failing first, orchestrator harness with a fake app-server outliving runtime 1)
c-2: running T completes after restart -> continuation run shows survivingRestart while waiting (client-runtime label derivation
unit test), then completes with T's final message; zero turn/start while T ran. T completes while down -> import at once. Second crash
during wait -> re-derived via the continuation's provider turn, still one T.
c-3: process killed during wait -> fallback, T on dead process only, exactly one new turn; unverifiable+unreachable -> no turn/start
until proven; replayed request -> error + interrupt + import interrupted result; enumeration failure at startup -> terminate -> today.
Stop: interrupt observed by fake, provider turn interrupted event; Force stop with another survivor on the instance -> refused with
message. Steer: interrupt then one new turn with the steer text.
c-4: unchanged (ownership unit tests).


## B9. Fold of audit round 7
- Single terminalization owner (r7 #3, #9, #14): each survivor has one waiter fiber that owns import and terminalization. Stop, Steer,
  end notifications, heartbeat failure and session loss only enqueue signals (Queue) to it; it acts once. New-turn fence: the native
  thread stays survivor-waiting (notifications ignored, requests fail closed) until the import commit; after the commit it re-reads the
  thread once: a native turn newer than T that is active -> turn/interrupt + thread/goal/set paused, logged.
- Stop outcome from native evidence (r7 new P1 #2): the waiter maps Codex's own terminal status from thread/read, never the existing
  interrupt-in-progress mapping (CodexAdapterV2.ts:6954): native interrupted -> provider turn interrupted ("stopped"); native completed
  -> import, run completed, Stop reported as "finished before it could be stopped". Interrupt with no terminal status within
  STOP_CONFIRM -> Force stop rules (B5).
- Process-loss fallback (r7 new P1 #1): on verified loss (pid gone, or socket closed + identity mismatch) while waiting, the waiter
  terminalizes the provider turn failed and the run failed with detail "The Codex process stopped while the turn that ran across the
  restart was still running", then offers ProviderContinuationRequests ({delivery:"message_text", detail: today's continuation prompt})
  — the adapter-initiated continuation path used for wakes (CodexAdapterV2.ts:5455, :6831). Once per survivor (owner fiber). Loss
  that cannot be verified -> B2 unknown hold, no continuation. No terminationCause is added to the provider-turn contract.
  Tests: verified loss -> exactly one new run and one turn/start on a fresh process, none on the dead one; user Stop never schedules it.
- Durable binding (r7 #8, #13): the provider-turn event is queued, not acknowledged (CodexAdapterV2.ts:2377). Accepted boundary: a crash
  between enqueue and ingest commit leaves the running continuation without a provider turn; recovery then finds no continuation
  candidate, and the startup phase (009 §1 step 6) interrupts T as a non-survivor. Fail-closed: T stops, the run shows cancelled by
  restart, nothing runs twice. Test this window explicitly.
- Release obligations (r7 #1): a declined continuation that cannot confirm T ended ends visibly (decline logged with the stop failure)
  and needs no durable retry: every later startup re-derives and interrupts non-survivors (009 §1 step 6) before any new turn.
- Unscoped requests (r7 #4): answered with an error synchronously on arrival; no GOAT-side wait depends on them; a nonresponsive
  process is caught by the heartbeat (B6). Test with a fake that sends account auth refresh and then goes silent.
- Guard installation (r7 #12): survivor-waiting marks are installed in the session constructor before the client's message stream is
  consumed (the factory passes the survivor set into session construction), so a replayed request before the resume response or
  before startTurn is already fail-closed. Tests: replay before the resume response; shared session first opened by another thread.
- Cross-client proof (r7 new P1 #3): contract schema round-trip test for survivingRestart; projection test that the field appears and
  clears through provider-turn updates; client-runtime label test; real-client pass in wp4 on web (test-goat-app) and mobile
  (test-goat-mobile) showing waiting, Stop and terminal states.
- Shutdown budget (r7 #5) and Linux identity (r7 #6): implementation-time verification in wp2/wp4 with the merged thread-3 contract
  and a CI Linux unit test; real Linux runtime NOT RUN on this macOS host.

