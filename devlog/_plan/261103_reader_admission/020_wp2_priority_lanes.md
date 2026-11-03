# 020 — wp2: interactive/background reader lanes

Starts from merged wp1 on dev. Re-verify every path:line at wp2 P.

## File change map

| Path | Op | Change |
|---|---|---|
| packages/shared/src/readerAdmission.ts | MODIFY | two FIFO queues (interactive, background); per-lane deadline; background holding cap; aging; `ReaderLane` reference + `backgroundReads` wrapper |
| packages/shared/src/readerAdmission.test.ts | MODIFY | lane contract tests |
| packages/shared/src/nodeSqliteReaderPool.ts | MODIFY | replace `Semaphore.make(size)` permits (41-42, 56-65) with a gate from readerAdmission (limit = size, background cap = size > 1 ? size − 1 : size, no deadline) exposing `take(1)`/`release(1)` so the transaction path at nodeSqliteClient.ts:1239-1254 keeps working unchanged |
| packages/shared/src/nodeSqliteReaderPool.test.ts | MODIFY | pool reservation/aging tests |
| packages/shared/src/nodeSqliteClient.ts | MODIFY | gate built with lane defaults; export `backgroundReads`; lane read from fiber context in admit (line-neutral) |
| background call sites | MODIFY | wrap the periodic entry point with `NodeSqliteClient.backgroundReads` (list below) |

## Gate rules (D7–D9)

- Lane comes from `ReaderLane` (`Context.Reference<"interactive" | "background">`, default interactive). `backgroundReads(effect)` provides "background" to the whole subtree, including forked fibers.
- Admission: limit 64; background may hold at most 48 (16 reserved for interactive); interactive may use all 64.
- Next waiter on release: if the oldest background waiter has waited ≥ 5 s and background holding < cap → that waiter; else oldest interactive; else oldest background if under cap. FIFO inside a lane. Aging never overrides the cap.
- Deadlines: interactive 30 s (`readerAdmissionTimeout`), background 10 s (`readerBackgroundAdmissionTimeout`). A background read is shed first because it gives up first and is capped first.
- Pool: same gate, no deadline (`timeout: undefined` = wait for the slot as today), cap size − 1 for background when size > 1.

## Background call sites (candidates; each must be confirmed at wp2 P by reading the entry and its failure handling)

| Call site | Stall-log evidence | Why background | Failure handling to confirm |
|---|---|---|---|
| apps/server/src/memory/MemoryWorker.ts:284 `MemoryWorker.catchUp` | 112 reader rows | memory indexing catch-up, periodic | worker retries next wake |
| MemoryWorker.ts:869 loop over `store.pendingForgetIntents(100)` | 19 (MemoryStore.pendingForgetIntents) | forget-intent drain | same |
| apps/server/src/orchestration-v2/ThreadSettlementService.ts:317 `ThreadSettlementServiceV2.sweep` | 22 | periodic settlement sweep; mark only the full sweep, not targeted settlement on a user action | sweep failure logged and retried |
| orchestration-v2/PullRequestWatchReactor.ts:630 sweep, PullRequestSyncReactor.ts:362 sweep | getThreadsWithPullRequests 6 | periodic PR polling | next tick |
| orchestration-v2/UsageLimitRecoveryWorker.ts:92 sweep | getLimitRecoveryCandidates 6 | periodic recovery worker | next tick |
| apps/server/src/storageCleanup.ts:1076 `StorageCleanup.sweep` | none in log; code: periodic housekeeping | housekeeping | worker retries |

Left interactive on purpose: readShellSnapshotRows/getThreadShell (UI), getRuntimeRecoveryProjection/readCanonicalProjection/getRecoveryThreadIds (recovery that gates a running turn or startup), ws.* handlers.

## Tests

Gate (readerAdmission.test.ts):
1. "background cannot take the interactive reserve" — limit 4, background cap 3: 3 background held, 4th background waits, interactive admitted at once.
2. "interactive goes first until a background waiter ages" — both lanes queued; release before 5 s → interactive; after `TestClock.adjust("5 seconds")` → oldest background.
3. "background gives up at its shorter deadline" — background overload at 10 s while an interactive waiter is still pending.
4. "aging does not break the background cap".
5. "cancellation in either lane returns the token" (refill to limit).
Pool (nodeSqliteReaderPool.test.ts):
6. "an interactive read gets the reserved slot while background holds the rest" (size 4).
7. "a single-slot pool prefers interactive on release and still serves aged background" (size 1).
Integration:
8. Same projection method under `backgroundReads` vs plain: with 3 slots held by background, the interactive call proceeds and the background call queues (server test, e.g. ProviderEventIngestor.readerOverload.test.ts fixture or a new focused test beside ProjectionStore).

Activation: reserve branch = 1/6; aging branch = 2/7; background deadline = 3; cap-vs-aging = 4.

## Accept criteria

Tests pass with 1–8 failing on wp1 dev first; `vp run check:changed` exit 0; code budgets respected; PR body lists every background-marked call site with its evidence line from the table.

## Bypass record

Lanes are caller-declared. An unmarked background job runs as interactive, which is the safe default. `onWriter` bypasses both gates. Residual risk: misclassifying an interactive path as background makes it shed early; mitigated by marking only periodic entry points.


## Revision 2 — reflection fixes (supersedes conflicting lines above)

R2-1 Lane-owning tokens. `acquire` returns a token `{ lane }`, and `release(token)` uses the token's lane, so a release never reads the fiber context. Pool: replace `permits` with the gate (`timeout: null`, limit = size, background cap = size > 1 ? size − 1 : size). Adapt both users:
- borrower path `nodeSqliteReaderPool.ts:56-64`: `Effect.acquireUseRelease(gate.acquire(lane, restore), (token) => lease…body, (token) => release slot then gate.release(token))`, in the same order as today (slot release, then permit release).
- transaction path `nodeSqliteClient.ts:1239-1254`: `lock.take(1)` becomes `pool.admit(lane, restore)`, which returns the token, and the finalizer calls `pool.permitRelease(token)` where it now calls `lock.release(1)`. The finalizer stays registered under `PreventSchedulerYield` before any yield, and worker retirement order is unchanged.

R2-2 Stranded capacity. Admission uses the wp1 single pump on every arrival and release. Eligibility per waiter: interactive is eligible when held < limit; background is eligible when held < limit and backgroundHeld < cap. Pick order: an aged background waiter (≥ 5 s) that is eligible, then the oldest eligible interactive waiter, then the oldest eligible background waiter. Test: 48 background held + 1 background queued (ineligible), interactive arrives → admitted at once. Same test at the pool: 3 background leases + 1 background queued, interactive arrives → gets slot 4.

R2-3 Failing-first. wp2 adds a feature, so tests that use `backgroundReads` are new coverage and cannot fail on wp1 dev. A behavioral regression that runs on wp1 dev with existing APIs: "an interactive read admitted after 60 queued reads does not wait behind all of them for a pool slot". Today it waits FIFO at the 4-slot semaphore. After the change it still waits FIFO, because all are interactive. So no honest failing-first test exists for wp2. This is disclosed in the PR as new coverage.

R2-4 Timeouts: interactive = `readerAdmissionTimeout` (30 s), background = `readerBackgroundAdmissionTimeout` (10 s), both validated as in 010 R2-1. The pool gate uses `null` explicitly.


## Revision 3

R3-1 Exactly-once tokens on the pool. A token granted to a fiber that is interrupted before it takes ownership (borrower: before `acquireUseRelease` hands it to use; transaction: before `Scope.addFinalizer` at `nodeSqliteClient.ts:1241-1259`) is returned by the gate's own onExit cleanup, the same rule as wp1 R2/R3. After the finalizer is registered, only the finalizer releases. Tests: borrower and transaction interruption while waiting for a pool slot, and while granted-not-claimed; afterwards all slots can be leased again (size 4: lease 4 concurrently).


## Revision 4 — diff-level hooks (supersedes the candidate table where they differ)

Server import added where missing: `import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";`. Each mark wraps the periodic entry only; writes are unaffected (lanes gate reader admission and pool slots only). Line counts on dev: MemoryWorker.ts 1004 lines (budget 1006), ThreadSettlementService.ts / PullRequestWatchReactor.ts / PullRequestSyncReactor.ts / UsageLimitRecoveryWorker.ts have no line budget.

1. apps/server/src/memory/MemoryWorker.ts:906-907 (sweepDue; catch-up 112 rows, pendingForgetIntents 19 rows in `deferred` at :869)
```diff
-      yield* sweepStage("catch-up", catchUp());
-      yield* sweepStage("deferred", deferred());
+      yield* sweepStage("catch-up", NodeSqliteClient.backgroundReads(catchUp()));
+      yield* sweepStage("deferred", NodeSqliteClient.backgroundReads(deferred()));
```
2. apps/server/src/orchestration-v2/ThreadSettlementService.ts:655-658. Only the full sweep (22 rows). The targeted settle stays interactive because of the latency comment at :653-654.
```diff
-    full: (refresh) => runSweep(null, undefined, refresh),
+    full: (refresh) => NodeSqliteClient.backgroundReads(runSweep(null, undefined, refresh)),
```
   The merge-event resweep at :795 stays interactive, because a merge is a user action.
3. apps/server/src/orchestration-v2/PullRequestSyncReactor.ts:599-603. Only scope "all" (the 1-minute timer at :702-706). "requested" comes from `requestSync` at :710-716 and stays interactive.
```diff
-      return sweep(scope);
+      return scope === "all" ? NodeSqliteClient.backgroundReads(sweep(scope)) : sweep(scope);
```
4. apps/server/src/orchestration-v2/PullRequestWatchReactor.ts:721. The periodic loop only; the exported `sweep` (:726) stays as is.
```diff
-          sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
+          NodeSqliteClient.backgroundReads(sweep).pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
```
5. apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:153 (getLimitRecoveryCandidates 6 rows)
```diff
-    yield* scheduler.register("usage-limit-recovery", sweep());
+    yield* scheduler.register("usage-limit-recovery", NodeSqliteClient.backgroundReads(sweep()));
```
   Implementer confirms `scheduler.register` re-runs the same effect value, so the wrapper applies to every run. If it takes a thunk, wrap inside it.
StorageCleanup is dropped: no stall-log evidence.

Failure handling, confirmed on dev: sweepStage (MemoryWorker), runSweep's catchCauseIf at ThreadSettlementService.ts:644-651, logSkipped in PullRequestSyncReactor.ts:602, and logFailure in PullRequestWatchReactor.ts:713 all log and continue, so a shed background read cannot crash its worker.

6. packages/shared/src/nodeSqliteReaderPool.ts
Before (41-42, 56-66):
```ts
  const permits = yield* Semaphore.make(size);
  …
  const use = <A, E, R2>(body: (connection: Connection) => Effect.Effect<A, E, R2>) =>
    permits.withPermits(1)(
      Effect.acquireUseRelease(
        Effect.sync(lease),
        (index) => Effect.flatMap(connection(index), body),
        (index) => Effect.sync(() => release(index)),
      ),
    );
  return { permits, lease, release, connection, use };
```
After:
```ts
  const permits = yield* makeReaderAdmission({ limit: size, backgroundLimit: size > 1 ? size - 1 : size, timeout: null, backgroundTimeout: null });
  …
  const use = <A, E, R2>(body: (connection: Connection) => Effect.Effect<A, E, R2>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        permits.acquire(restore),
        () => Effect.acquireUseRelease(Effect.sync(lease), (index) => restore(Effect.flatMap(connection(index), body)), (index) => Effect.sync(() => release(index))),
        (token) => permits.release(token),
      ),
    );
  return { permits, lease, release, connection, use };
```
(Slot release runs before the permit release, as today.)

7. packages/shared/src/nodeSqliteClient.ts transaction path, 1239-1254
Before:
```ts
          const lock = "pool" in target ? target.pool.permits : target.lock;
          let leased = -1;
          const acquire = Effect.tap((pending?.restore ?? restore)(lock.take(1)), () => {
            …
            return Scope.addFinalizer(scope, Effect.sync(() => {…}).pipe(Effect.andThen(lock.release(1))));
```
After:
```ts
          let leased = -1;
          const take = "pool" in target ? target.pool.permits.acquire(pending?.restore ?? restore) : (pending?.restore ?? restore)(target.lock.take(1));
          const acquire = Effect.tap(take, (token) => {
            …
            return Scope.addFinalizer(scope, Effect.sync(() => {…}).pipe(
              Effect.andThen("pool" in target ? target.pool.permits.release(token as ReaderToken) : target.lock.release(1))));
```
The token type is a discriminated value, with no `as` in the final code. The implementer narrows by the same `"pool" in target` check, for example by computing `{ take, release }` once per target. Budget: nodeSqliteClient.ts stays ≤ 1318; if not, the admission hook moves into readerAdmission.ts (010 R2-7).

8. Lane API in readerAdmission.ts
```ts
export type ReaderLaneName = "interactive" | "background";
export const ReaderLane = Context.Reference<ReaderLaneName>("@goat/shared/readerAdmission/Lane", { defaultValue: () => "interactive" });
export const backgroundReads = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, ReaderLane, "background");
export interface ReaderToken { readonly lane: ReaderLaneName }
```
`acquire(restore)` reads `ReaderLane` from the fiber once and returns a `ReaderToken`; `release(token)` uses `token.lane`. Re-export `backgroundReads` from nodeSqliteClient.ts beside `failFastReaderAdmission`. Client admission: `makeReaderAdmission({ limit: 64, backgroundLimit: 48, timeout: readerAdmissionTimeout ?? 30 s, backgroundTimeout: readerBackgroundAdmissionTimeout ?? 10 s, agingMs: 5000 })`; the pool passes `agingMs: 5000` too.


R4-9 (replaces item 1 and the MemoryWorker line count above). MemoryWorker.ts is 1006/1006 lines, so the file is not touched. Mark at the start site instead: apps/server/src/memory/MemoryApplicationLayers.ts:172
```diff
-      yield* worker.start();
+      yield* NodeSqliteClient.backgroundReads(worker.start());
```
The drainable worker that runs `sweepDue` (MemoryWorker.ts:971-978), the wake stream and the 5 s wake loop are forked inside `start` (`forkScoped` at :985-994) and inherit the ReaderLane reference, so catch-up (112 rows) and deferred/pendingForgetIntents (19 rows) run as background. `drain` with no started worker calls `sweepDue()` directly on the caller's lane (interactive), which is the right behavior for an explicit drain. Test: a fiber forked inside `backgroundReads` acquires a background token (gate test 6 in R4 list → add "lane is inherited by forked fibers").


## Revision 5 — audit r2 fixes (supersedes R4-9 and the SqlError mapping in 010 R4-1)

R5-1 Memory mark scoped to sweeps only. R4-9 is withdrawn because wrapping `worker.start()` would put startup's `readThreadHookWatermark` (MemoryWorker.ts:987-992) on the background lane before any catch handler exists, and MemoryApplicationLayers.ts:169-176 awaits it during layer construction. Instead, mark only the drainable worker's process step at apps/server/src/memory/MemoryWorker.ts:974:
```diff
-        Effect.andThen(sweepDue()),
+        Effect.andThen(NodeSqliteClient.backgroundReads(sweepDue())),
```
plus `import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";`. That process step already logs and continues on failure (`Effect.catch` → "Memory sweep deferred", :975-977). Startup reads, `drain` without a started worker (:1002), and `execute` stay interactive. Budget: MemoryWorker.ts is 1006/1006, so the import line must be paid for by moving one existing self-contained helper out of MemoryWorker.ts into a new or existing memory module. Raising the baseline is not allowed (AGENTS.md "Move code into a new module instead of raising the baseline"). The implementer picks the smallest such helper and the reviewer checks it is a pure move. Test: a sweep run by the started worker acquires background tokens; `drain` with no worker uses interactive.

R5-2 One SqlError mapping for both gates. readerAdmission.ts exports
```ts
export const admissionSqlError = (cause: ReaderAdmissionOverloadError | ReaderAdmissionClosedError) =>
  new SqlError({ reason: classifySqliteError(cause, {
    message: cause instanceof ReaderAdmissionOverloadError ? "Database reader overloaded" : "Database client closed",
    operation: "acquire" }) });
```
(the same `classifySqliteError` shape that `classifyError` in nodeSqliteClient.ts uses; the implementer matches its exact signature). The client admission hook, the pool borrower `use` and the pool transaction acquire all apply `Effect.mapError(admissionSqlError)`, so the pool's `use` keeps its `SqlError` channel (nodeSqliteReaderPool.ts:10-12,52-54). The pool gate has `timeout: null` and never produces overload. Tests: close the client while a borrower read and a transaction are each queued at the pool (size 1, slot held); both fail with "Database client closed" and `isReaderAdmissionOverload` false.


R5-3 The fail-fast policy is a gate option, not an ambient read. `makeReaderAdmission({ …, honorFailFast: boolean })`: the client admission gate passes `true` and the pool gate passes `false`, so the pool always waits for a slot, as today. Test (wp2, pool): an opted-in `withWriterFallback` read with all 4 slots held and admission capacity free stays pending, does not reach the writer, and runs when a slot frees up.

