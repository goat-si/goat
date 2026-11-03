# 030 — wp3: retain on restart, claim on startup, adopt the native turn

Criteria fed: c-2 (failing-first restart simulation), c-3 (fallback), c-4 (sweep), D3 MCP refusal.
P of wp3 MUST re-verify: (a) projection behavior when an item event re-uses an existing turnItemId under another run,
(b) whether ProviderAdapterV2TurnInput can carry the source run's native turn id, (c) thread 3's merged stop-intent reader.

## 1. Stop intent (apps/server/src/serverStopIntent.ts NEW, ~90 lines)
```ts
export type ServerStopKind = "restart" | "quit";
export class ServerStopIntent extends Context.Service<ServerStopIntent, {
  readonly markRestart: (reason: "runtime-drain" | "update") => Effect.Effect<void>;
  /** Read once at shutdown: in-process mark, else desktop-stop-intent.json (thread 3 contract), else "quit". */
  readonly resolve: Effect.Effect<{ kind: ServerStopKind; reason: string }>;
}>()("goat/ServerStopIntent") {}
```
- Desktop file reader: packages/contracts/src/desktopStopIntent.ts (DESKTOP_STOP_INTENT_FILE, DesktopStopIntent schema) — use thread
  3's reader if merged (readDesktopStopIntent(stateDir)); otherwise add the contract exactly as agreed and a 20-line reader; whichever
  lands second rebases. Accept only pid === process.pid; delete after read; restart reasons {relaunch, update-install, recovery-retry}.
- runtimeDrain.ts:104-105: before `yield* shutdown.shutdown` call `stopIntent.markRestart("runtime-drain")`.
- resolve memoized per process (first call wins).

## 2. Retention at shutdown (ProviderRuntimeRecoveryService.prepareForShutdown :878-930)
After a continuation effect is written for `run`, collect run.providerInstanceId (projection.thread.providerInstanceId fallback) into
a set. At the end: setting = settings.codexTurnsSurviveServerStop; stop = stopIntent.resolve;
retain iff setting === "always" || (setting === "restart" && stop.kind === "restart"); if retain, for each instance in the set call
CodexDetachedAppServers.retainOnClose(instance). (Instances not detached ignore it.) Log {kind, reason, retainedInstances}.
prepareForShutdown already precedes providerSessions.shutdown (serverRuntimeStartup.ts:561), so the session scope finalizer
(020 §2 step 4) sees the mark. Shutdown stays within the launcher's 5 s budget: retained processes are not awaited.
Crash path: no finalizer runs; record and process survive by construction.

## 3. Startup sweep and claim
- serverRuntimeStartup.ts:630 after `recover`: keep = provider instances of threads with a pending provider-runtime.continue effect
  (new EffectOutbox read pendingContinuationThreadIds -> projection thread providerInstanceId); `CodexDetachedAppServers.sweep(keep)`.
  Runs before effect activation so no continuation opens a session first.
- Claim = the first openSession for that instance (020 §2 step 1) — continuation or a new user turn, either reuses the process.
- EffectWorker.ts:93 provider-runtime.continue: after continueRestartedRun completes (dispatched OR declined), if no other pending
  continuation remains for the same instance, `releaseIfUnclaimed(instance)` — a declined continuation (archived, user stop, setting
  off, chain limit) does not leave an orphan running unattended. When the continuation was declined because the user stopped the
  thread, the retained native turn must be interrupted first: releaseIfUnclaimed terminates the whole group, which ends it.

## 4. Adoption in CodexAdapterV2 (startTurn / startNativeTurn, :7749-7773, :7215-7280)
Condition: client.reattached && turnInput.restartContinuationOfRunId !== undefined.
1. After resumeThread (already called by the session manager) request thread/turns/list or thread/read {threadId, includeTurns:true}
   (resume uses excludeTurns:true at :7602) to get the latest native turn T.
2. If T.status === "inProgress": registerRootTurn({turnInput, nativeTurnId:T.id, startedAt:T.startedAt}) under
   turnTerminalizationPermit; do NOT send turn/start; replay T's completed items through the existing item/completed handler path
   (deterministic turnItemFromProviderItem ids; see P check (a)); live notifications continue the turn to turn/completed.
3. If T finished (completed|failed|interrupted) and T.id is the source run's native turn (P check (b): add
   `restartContinuationOfNativeTurnId?: string` to ProviderAdapterV2TurnInput, set in RestartContinuation from the source run's latest
   provider turn nativeTurnRef) -> registerRootTurn, replay T's items, then run the turn/completed handler with T's status so the
   continuation run settles with the result without a model call.
4. Otherwise (T is older than the source turn, or lookup fails) -> existing startNativeTurn path unchanged (fallback, c-3).
5. Never retry: if any step fails, fall through to (4) once; no loop. MAX_CONTINUATION_CHAIN unchanged.

## 5. MCP refusal (D3) — apps/server/src/mcp/mcpAuthResponse.ts:22
earlier_server text becomes: "GOAT refused this call: the GOAT server restarted while this turn kept running, so GOAT tools are
unavailable for the rest of this turn. Do not retry this tool in this turn; continue without GOAT tools. GOAT installs a fresh
credential when the next turn starts." The response stays the existing tool error result (isError).

## Tests (failing first)
CodexAdapterV2.restartAdoption.test.ts (new file; fake app-server over an in-memory message channel whose state outlives the first
session scope; it.effect + Deferred, no sleeps):
- "a continuation adopts the Codex turn still running after a restart without sending turn/start" (c-2): session 1 starts turn T;
  close session 1 as server_shutdown with retainOnClose; open session 2 (reattached:true); continuation startTurn; assert no
  turn/start recorded by the fake, then fake emits item/completed + turn/completed for T; assert provider events for the continuation
  run end with provider_turn completed. Fails before the change (turn/start is sent).
- "a turn that finished while GOAT was down settles the continuation with its result" (c-2 variant).
- "without a reattached app-server the continuation starts a turn as before" (c-3).
- "a dead retained app-server falls back to spawning and the continuation starts a turn" (c-3; fake ProcessTable says gone).
ProviderRuntimeRecoveryService test: "prepareForShutdown retains Codex instances only for restart stops unless set to always".
serverStopIntent.test.ts: pid mismatch / malformed / missing -> quit; relaunch|update-install|recovery-retry -> restart; file deleted.
McpSessionRegistry / McpHttpServer test (D3): "a token from before a restart is refused with the turn-scoped message, and the token
issued for the next turn resolves".
Commands: vp test run <these files> + touched existing adapter tests (CodexAdapterV2.reload.test.ts, stopSweep);
vp run typecheck.


## Amendment A1 (found during A, main): projection identity of an adopted turn
- Turn items upsert on turn_item_id and the update rewrites run_id/node_id/provider_turn_id (ProjectionStore.ts:3002-3042).
- Ids derive from native ids only: providerTurn(nativeTurnId) (IdAllocator.ts:279-282), turnItemFromProviderItem(nativeItemId)
  (IdAllocator.ts:287-290). registerRootTurn derives providerTurnId from nativeTurnId (CodexAdapterV2.ts:2489-2492).
Consequences and plan changes:
1. An adopted turn must NOT reuse the source run's provider turn id (it would move the source run's provider turn record to the
   continuation attempt). Add optional `providerTurnIdSalt` to registerRootTurn input; for adoption derive
   providerTurn({driver, nativeTurnId: `${T.id}:restart:${turnInput.runId}`}). Notification routing is unaffected (activeTurns keyed by
   nativeTurnId). P check: every place that re-derives providerTurnId from nativeTurnId (rg "derive.providerTurn" in the adapter) must use
   the context's providerTurnId instead.
2. Items that started before the restart and complete after adoption keep their id and move to the continuation run — accepted
   (that is where they finished); the source run's copy was already terminalized as cancelled by recovery.
3. Gap import (§4.2/§4.3) replays only completed items that GOAT never saw: add `restartContinuationKnownItemIds?: ReadonlySet<string>`
   (native item ids) to ProviderAdapterV2TurnInput, computed in RestartContinuation from projection.turnItems of the source run whose
   provider turn nativeTurnRef matches; skip those ids during replay. Without it, replay would move pre-restart items.
4. New test: "replaying an adopted turn does not move items the interrupted run already showed".

