# 006 — Revision R1: fold of audit round 1 (terra reviewer, VERDICT FAIL, 8 P1 + 2 P2)

This document overrides 010/020/030 where they conflict. Each item names the finding it answers.

## Acceptance criteria made observable (finding 8)
- c-2: In an orchestrator-level integration test (two server runtimes over one database and one fake Codex app-server whose state
  outlives the first runtime), a Codex run whose native turn T is running at shutdown is terminalized by recovery, its continuation
  run binds to T without any turn/start request reaching the fake, and the continuation run reaches status completed with T's final
  agent message as its last assistant message. Variant: T completes while no server runs -> continuation settles with T's result and
  zero turn/start. Both fail on dev before the change.
- c-3: Same harness. (a) retained process gone or identity mismatch at startup -> record removed, a fresh app-server is spawned, the
  continuation sends turn/start exactly as today. (b) adoption cannot read T's state -> T is interrupted (turn/interrupt observed) and
  only after the fake reports T interrupted does turn/start run; if interrupt fails the continuation run fails with a clear error and no
  turn/start. (c) a continuation that RestartContinuation declines (pending approval/question/secret, user stop, archived, chain limit)
  interrupts its native turn and never adopts it.
- c-4: unit tests on CodexDetachedAppServers with a fake ProcessTable + record dir: verified-group-only signals, pid reuse, unverifiable
  identity keeps the record (no signal, no delete), per-thread claims, terminate only when every claim is settled.

## Ownership on a SHARED app-server (finding 1)
Record (one per instance) gains a survivor ledger, written at the START of startup (not by a finalizer), so the crash path is covered:
```ts
readonly survivors?: ReadonlyArray<{
  readonly threadId: ThreadId; readonly sourceRunId: RunId;
  readonly nativeThreadId: string; readonly nativeTurnId: string;
  readonly state: "pending" | "adopted" | "released";
}>;
```
- Startup ledger (new phase between recover and startEffectWorker, see sequencing): for each instance record whose process verifies,
  survivors = runs that have a pending provider-runtime.continue effect for that instance, with nativeThreadId/nativeTurnId from the
  source run's latest provider turn (projection providerTurns.nativeTurnRef). Instances whose record verifies but have zero survivors
  -> terminate (sweep). Records that do not verify -> see identity rules.
- The process is attached by the first session open of that instance (any thread). From then it is the live shared session.
- Per-thread claim: adoption marks its entry adopted; a declined continuation marks released and, if attached, sends turn/interrupt for
  that nativeTurnId on that nativeThreadId; if not yet attached the interrupt runs at attach (adapter receives pending releases).
- At attach the adapter interrupts every active native root turn on the process that is not a pending/adopted survivor (no owning run;
  same policy the turn/started handler already applies to orphan goal turns, CodexAdapterV2.ts ~4990).
- Termination of the shared process is allowed only when: (i) startup found zero survivors, or (ii) the instance session closes for a
  non-shutdown reason (settings change, idle release, user stop) AND no survivor is pending, or (iii) fingerprint changed while down
  (explicitly ends the survivors; they fall back to today's continuation — proven stopped by termination). A non-shutdown close with
  pending survivors detaches (socket close only) and the process waits for its claims; when the last claim settles with no session
  attached, terminate.
- Retention mark at shutdown (prepareForShutdown) remains only the decision input "keep vs terminate now"; correctness of claims
  never depends on it.

## Adoption identity and fail-closed boundary (finding 2)
- Adopt only T where T.id === ledger.nativeTurnId for this continuation's sourceRunId. Identity travels: RestartContinuation reads the
  ledger entry (via CodexDetachedAppServers.survivorFor(threadId, sourceRunId)) — not through ProviderAdapterV2TurnInput — so no
  provider contract change is needed for non-Codex adapters. The Codex adapter asks the same service at startTurn.
- Decision table at startTurn (continuation + survivor entry present):
  | native state of T | action |
  | running | adopt (register, then snapshot) |
  | finished | adopt-finished (register, replay unknown items, synthesize completion) |
  | unknown (read failed) | turn/interrupt T; on confirmed interrupted -> existing turn/start; on failure -> fail run, no turn/start |
  | another active turn on the thread | interrupt it (orphan) then treat T by its state |
- No survivor entry -> existing path unchanged.

## Atomic handoff of live and snapshot events (finding 3)
Order under turnTerminalizationPermit: (1) registerRootTurn for T with a distinct providerTurnId (A1) so live notifications route;
(2) thread/read includeTurns after registration; (3) replay completed items of T that are neither in knownItemIds (source run, A1) nor
already seen live (context.seenNativeItemIds, new Set on the context); (4) if the snapshot shows T finished and the context is still
active, run the existing turn/completed terminalization with the snapshot's status. A live turn/completed that lands before (1) is
dropped today (CodexAdapterV2.ts:6945) — the post-registration snapshot then shows T finished, so (4) settles it. A live completion
after (1) wins and (4) sees the context gone. Tests: completion before registration, during snapshot, after snapshot; item seen live
and in snapshot emitted once.

## Requests, goals, subagents (finding 4)
- Approvals / user input / secrets / MCP elicitations pending at restart: RestartContinuation already declines such runs
  (restartContinuationBlocked, RestartContinuation.ts:59-84) -> survivor released -> native turn interrupted. No adoption of a turn
  waiting on a request. Test: pending approval at shutdown -> interrupt, no adoption.
- Goal turns: adoption covers the native turn T only. A later turn Codex starts on its own hits the existing orphan-goal handler (pause
  + interrupt). Goal chains after restart therefore pause instead of running unowned. Test.
- Native subagent threads of T keep running inside Codex and report to T internally; GOAT does not mirror their progress after restart
  (their GOAT items stay as recovery terminalized them). Notifications from unknown subagent native threads must be ignored without
  failing T. Test with a fake subagent notification.

## Shutdown/startup sequencing and budget (finding 5)
- Startup: new phase "codex.survivors" in runOrderedV2StartupPhases between recover and recoverDelegatedTasks/startEffectWorker
  (serverRuntimeStartup.ts:520-524, :630-639): reads pending continuation effects (EffectOutbox read added), builds ledgers, sweeps.
  Runs before the worker can dispatch a continuation; session opens before worker start are only user requests, which are admitted
  after startup completes.
- Shutdown: detached terminate on server shutdown = SIGTERM to the verified group with NO wait (retained ones: nothing). Record keeps
  state "terminating"; startup SIGKILLs a still-alive verified "terminating" group. Fits the launcher's 5 s budget
  (serviceLauncher.ts:52). Non-shutdown closes keep the bounded SIGTERM->SIGKILL wait (TestClock in tests).
- Crash between spawn and record update: record with socketPath + state "spawning" is written BEFORE spawn; pid is written
  synchronously after spawn() returns. A "spawning" record without pid at startup is unverifiable: keep it, report through the
  existing stray-process diagnostics, never signal.

## Identity on Linux/macOS (finding 6)
- Pass ["app-server", ..., "--listen", "unix://"+socket] INTO AgentScope.wrap args (survivesRestart: true so the systemd slice is not
  torn down with the server's; shared: true as today). systemd-run --scope execs in place (agentScope.ts:84 comment), so the spawned pid
  is the group leader (detached: true) and argv of the final exec contains the socket path.
- verify(record) = group exists AND pgid===record.pgid AND some member's argv contains record.socketPath (macOS: ps -o pgid=,command=;
  Linux: /proc/<pid>/stat field 5 + /proc/*/cmdline of members listed by ps -o pid= -g). Outcomes: verified | gone (no process with
  pid) | mismatch (pid exists, pgid/argv differ = reuse) | unverifiable (ps failed). gone/mismatch -> delete record, no signal.
  unverifiable -> keep record, no signal, retry next startup.
- Verify-to-signal race: signal the group immediately after verification; PID reuse within that window requires the whole group to
  exit and a new group leader to reuse the pid — accepted residual risk, noted in the PR.

## Transport hardening (finding 7)
- send() is serialized with a Semaphore(1) so fragments of concurrent messages never interleave.
- Tests: concurrent 20 MB + small messages arrive intact and in send order; multi-byte UTF-8 split across fragment boundaries
  reassembles; peer close (EOF) and peer error take the EOF and error termination paths respectively and fail pending requests;
  >64 MiB send fails before writing; alias path > 103 bytes is refused (falls back to stdio with a logged reason).

## Repository constraints (finding 9)
- CodexAdapterV2.ts has 16 lines of budget (8608 of 8624). First extract layerAppServerClientFactory + makeCodexAppServerSpawnCommand
  (:1481-1648) into Adapters/CodexAppServerClientFactory.ts (GOAT-owned), then add adoption as Adapters/CodexRestartAdoption.ts with a
  thin startTurn hook. All new reusable functions are Effect.fn("Module.op").
- SETTINGS_ACCESS: codexTurnsSurviveServerStop classified "agent" (reason: reversible operational preference like
  continueThreadsAfterServerUpdate); reviewer may push to person for "always".
- Settings UI gets one real-client pass (test-goat-app) in wp4; mobile: assess whether mobile settings list restart continuation.

## MCP wording (finding 10)
earlier_server text: "GOAT refused this call: this thread's GOAT credential was issued before the GOAT server restarted. GOAT tools stay
unavailable until this thread's next turn starts, so do not retry them in this turn." Valid for every earlier_server token.

