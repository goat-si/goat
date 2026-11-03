# 010 — wp1: deadline-bounded FIFO reader admission

Re-verify against current dev at wp1 P (line numbers below are from 21c65d8620).

## File change map

| Path | Op | Change |
|---|---|---|
| packages/shared/src/readerAdmission.ts | NEW | admission gate (≤ ~150 lines) |
| packages/shared/src/readerAdmission.test.ts | NEW | contract tests for the gate under TestClock |
| packages/shared/src/nodeSqliteClient.ts | MODIFY | replace counter (1118-1131) with the gate; pass caller restore at 1166-1169 and 1227-1230; config field; re-export fail-fast helper. Net lines ≤ +10 (budget 1318) |
| packages/shared/src/nodeSqliteClient.workerRecovery.test.ts | MODIFY | "bounds reader admission before the connection semaphore" (237-277) becomes wait-then-deadline; add wait-then-admit FIFO and cancel-leaves-queue cases |
| apps/server/src/orchestration-v2/readerOverloadFallback.ts | MODIFY | fallback reads run with fail-fast admission |
| apps/server/src/orchestration-v2/ProviderEventIngestor.readerOverload.test.ts | MODIFY | "fails reads outside provider ingestion fast" (596-603) becomes "waits until the admission deadline"; ingestion cases stay immediate (no TestClock advance) |

Out: nodeSqliteReaderPool.ts (wp2), any server call site other than readerOverloadFallback.ts.

## NEW packages/shared/src/readerAdmission.ts (shape; implementer may refine names)

```ts
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ReaderAdmissionOverloadError } from "./readerAdmissionOverload.ts";

export const DEFAULT_READER_ADMISSION_LIMIT = 64;
export const DEFAULT_READER_ADMISSION_TIMEOUT: Duration.Input = "30 seconds";

/** Reads that recover elsewhere on overload skip the wait and fail at once. */
export const FailFastReaderAdmission = Context.Reference<boolean>(
  "@goat/shared/readerAdmission/FailFast", { defaultValue: () => false });
export const failFastReaderAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FailFastReaderAdmission, true);

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
interface Waiter { readonly deferred: Deferred.Deferred<void, ReaderAdmissionOverloadError>; readonly deadline: number; state: "queued" | "granted" | "settled" }

export const makeReaderAdmission = (options: { readonly limit?: number; readonly timeout?: Duration.Input }) => {
  // held = tokens owned by admitted readers + tokens granted to a waiter that has not resumed yet.
  let held = 0; const queue: Array<Waiter> = [];
  const release: Effect.Effect<void> = /* sync: drop expired head waiters (complete them with overload);
     hand the token to the oldest live waiter (state granted, Deferred succeed) or held-- */;
  const acquire = (restore: Restore | undefined): Effect.Effect<void, ReaderAdmissionOverloadError> =>
    /* withFiber: if held < limit && queue.length === 0 -> held++ (no barging).
       else if FailFastReaderAdmission -> fail overload.
       else enqueue {deadline: Clock now + timeout}; await under (restore ?? identity) with a deadline
       that fires even for an uninterruptible caller; onExit: granted-but-failed/interrupted -> release (pass token on);
       queued -> remove from queue; mark settled. Deadline equality = expired. */;
  return { acquire, release };
};
```

Invariants the tests pin: each token has exactly one owner and exactly one release; `held ≤ limit`; a waiter never barges an older one; cancellation removes the waiter or forwards its granted token; overload only from deadline expiry (or explicit fail-fast).

## MODIFY packages/shared/src/nodeSqliteClient.ts

Before (1118-1131):
```ts
  let admittedReaders = 0;
  const admit = (target: { readonly name: Acquired["connection"] }) =>
    Effect.suspend(() => {
      if (target.name !== "reader") return Effect.void;
      if (admittedReaders >= 64)
        return Effect.fail(
          failed(new ReaderAdmissionOverloadError(), "Database reader overloaded", "acquire"),
        );
      admittedReaders++;
      return Effect.void;
    });
  const releaseAdmission = (target: { readonly name: Acquired["connection"] }) =>
    Effect.sync(() => {
      if (target.name === "reader") admittedReaders--;
    });
```
After:
```ts
  const admission = makeReaderAdmission({ timeout: options.readerAdmissionTimeout });
  const admit = (target: { readonly name: Acquired["connection"] }) =>
    target.name !== "reader"
      ? Effect.void
      : Effect.withFiber((fiber) =>
          admission.acquire(fiber.getRef(TransactionAcquire)?.restore ?? Context.get(fiber.context, ReadOnly)).pipe(
            Effect.mapError((cause) => failed(cause, "Database reader overloaded", "acquire")),
          ),
        );
  const releaseAdmission = (target: { readonly name: Acquired["connection"] }) =>
    target.name === "reader" ? admission.release : Effect.void;
```
Config (after 1115 `readerPoolSize` doc line at 55-56):
```ts
  /** Longest a read waits for one of the 64 reader admissions before failing as overloaded; 30 seconds by default. */
  readonly readerAdmissionTimeout?: Duration.Input | undefined;
```
Exports (near 64-66): `export { failFastReaderAdmission } from "./readerAdmission.ts";`. The `ReaderAdmissionOverloadError` import stays only if still used. The implementer confirms which restore applies in each path: the borrower has no TransactionAcquire, so it uses ReadOnly; the transaction path uses `pending.restore` when present (`:1284-1301`).

## MODIFY apps/server/src/orchestration-v2/readerOverloadFallback.ts

Before (18-30): `method(...args).pipe(NodeSqliteClient.readOnly, Effect.catchIf(...))`.
After: decide fallback eligibility first, then run the reader attempt with `failFastReaderAdmission` only when the writer retry will happen:
```ts
  (...args: Args): Effect.Effect<A, E, R> =>
    Effect.withFiber((fiber) => {
      const fallback = always || fiber.getRef(WriterFallback);
      const read = method(...args).pipe(NodeSqliteClient.readOnly);
      return fallback
        ? NodeSqliteClient.failFastReaderAdmission(read).pipe(
            Effect.catchIf(NodeSqliteClient.isReaderAdmissionOverload, () =>
              NodeSqliteClient.onWriter(method(...args))))
        : read;
    });
```
Doc comment updated: other reads wait for admission up to the client deadline.

## Tests (each fails on dev except the regression guards)

Contract tests in readerAdmission.test.ts (`it.effect`, TestClock, Deferred):
1. "admits waiters in arrival order when tokens free up" — limit 2, hold 2, enqueue A, B; a later C arrives after one release → A admitted, B before C. Dev: module absent.
2. "fails a waiter as overloaded exactly at its deadline" — adjust to deadline−1 ms: pending; +1 ms: `ReaderAdmissionOverloadError`.
3. "an interrupted waiter leaves the queue and does not consume a token" — interrupt A, release → B admitted; then refill to limit to prove no leak.
4. "a token granted to a waiter that is interrupted before resuming passes to the next waiter" — release and interrupt in the same synchronous step (Deferred-driven) → B admitted, held count exact (refill to limit; limit+1 waits).
5. "skips expired waiters at handoff" — A expires at t, release at t → A overload, B admitted.
6. "fail-fast callers never wait" — FailFastReaderAdmission → immediate overload while full; immediate admit when free.
7. "the deadline still fires for an uninterruptible caller" — acquire under `Effect.uninterruptible` with restore = undefined → still fails at deadline.

Integration (real client, workerRecovery.test.ts, readerPoolSize 1, held worker):
8. Rewrite 237-277: 65th read is pending (`pollUnsafe()` undefined) and after `TestClock.adjust("30 seconds")` fails with the same SqlError/overload predicate assertions. Dev: fails (resolves immediately).
9. New: 65th read waits; interrupt one admitted read → the 65th gets admitted (completes once the worker is released). Dev: fails.

Server (ProviderEventIngestor.readerOverload.test.ts):
10. Rewrite 596-603: projection.getThread under saturation is pending, then overload after `TestClock.adjust("30 seconds")`. Dev: fails.
11. Regression guard: the existing ingestion cases (578-594) and "reruns an ingestion read on the writer inside an enclosing readOnly" (605-613) pass without advancing TestClock. Dev: passes, must stay passing.

Activation scenarios: deadline branch = test 2/8/10; fail-fast branch = 6/11; late-grant branch = 4; expired-at-handoff branch = 5; uninterruptible branch = 7.

## Accept criteria

- All tests above pass; 8, 9, 10 shown failing on dev first (run against `git stash` of the source change or before the source edit).
- `vp run check:changed` exit 0; nodeSqliteClient.ts ≤ 1318 lines.
- PR body: problem, fix, tests, model/harness line.

## Bypass record (PLAN-BYPASS-NAMED-01)

The gate is in-process policy, not enforcement: `onWriter` reads never pass through it, and a `readerWorker: false` client has no reader admission. Residual risk: a waiter-count spike under extreme arrival rates (memory). No wording downgrade needed.


## Revision 2 — reflection fixes (supersedes conflicting lines above)

R2-1 Timeout option. `makeReaderAdmission({ limit, timeout })` takes `timeout: Duration.Duration | null`; `null` means no deadline (used by the pool in wp2). The client decodes `readerAdmissionTimeout` with `Duration.fromInput`/decode and dies like `readerPoolSize` (`nodeSqliteClient.ts` readerPool validation pattern, `nodeSqliteReaderPool.ts:36-39`) unless finite and ≥ 0; 0 means "never wait".

R2-2 Deadline mechanism. The deadline does not rely on interrupting the await. On enqueue the gate forks a timer fiber (`Effect.sleep(timeout)` then a synchronous `expire(waiter)`), detached from the caller so it runs under TestClock and regardless of the caller's interruptibility. `expire` completes the waiter's Deferred with `ReaderAdmissionOverloadError` only when the waiter is still `queued`. Settling a waiter (grant, expiry, cancel) interrupts its timer. The caller's await is `(restore ?? identity)(Deferred.await(deferred))`; an uninterruptible caller is still woken by the timer's failure.

R2-3 Grant vs deadline (rebuttal of reflection gap 4, recorded). Grant and expiry are both synchronous transitions of the same waiter record, so exactly one wins. A grant that happens before the deadline is an admission on time; the delay before the fiber resumes is scheduler latency, not admission waiting, and the grantee owns the token. No claim-time recheck. A test pins this: grant at deadline − 1 ms, then advance past the deadline before joining → the read is admitted, and the token count is exact.

R2-4 Single pump. Arrival and release both call one synchronous `pump()` that grants tokens to the oldest eligible waiters while capacity remains. Arrival is "enqueue, then pump", so FIFO holds without a separate fast path, and wp2 can never strand free capacity behind an ineligible waiter (arrival of an eligible waiter triggers pump).

R2-5 Integration tests for both masked sites (replace 8–9 with this list; all use existing public APIs, so each one fails on dev behaviorally):
- 8a statement borrower: 65th `sql\`SELECT\`.pipe(readOnly)` is pending, then fails with the overload predicate after `TestClock.adjust("30 seconds")`.
- 8b transaction: same with `sql.withTransaction(...).pipe(readOnly)`.
- 9a/9b: for each shape, interrupt the pending 65th read, then interrupt one admitted read and release the worker. A new read is admitted, and refilling to 64 shows no leaked token.
- 9c: an uninterruptible caller (`Effect.uninterruptible` around the readOnly read) still fails at the deadline through the real client.
- 9d: admitted in FIFO order. Two pending overflow reads A then B; one admitted read finishes → A runs before B.

R2-6 Failing-first wording. Behavioral failing-first proof = 8a, 8b, 9a–9d, and server test 10, all run on the dev source before the fix. Gate unit tests 1–7 are new coverage of a new module, not failing-first proof.

R2-7 Line budget. Accept only an actual `wc -l` ≤ 1318 for nodeSqliteClient.ts after the change. If the hook does not fit, move the restore selection into `readerAdmission.ts` (e.g. `admission.acquireFor(fiber)`) until it fits.


## Revision 3 — timer lifecycle (supersedes R2-2 where it conflicts)

R3-1 Owner. `makeReaderAdmission` is an Effect run inside the client's `make` scope. It captures that `Scope` and forks each waiter's timer with `Effect.forkIn(timer, clientScope, { startImmediately: true })` (`effect/src/internal/effect.ts:5631-5643` installs and removes the scope finalizer). It keeps the handle on the waiter.

R3-2 Absolute deadline. `deadline = Clock.currentTimeMillis at request + timeout`, captured in `acquire` before enqueue. The timer sleeps `max(0, deadline − now)`, then calls `expire(waiter)`. `pump()` checks `now >= deadline` → expire, never grant, before granting any waiter, so equality is expired even if the timer has not run yet. A grant requires `now < deadline`.

R3-3 Settlement. A waiter record moves once from `queued` to one of `granted | expired | cancelled | closed`. Grant and cancel interrupt the timer handle if one is installed (`Fiber.interrupt` forked into the scope, not joined synchronously). Expiry runs on the timer fiber and finishes normally without interrupting itself. If a grant or cancel lands before the timer handle is installed, the timer checks the waiter state on its first step and exits. Both orderings are tested.

R3-4 Scope close. A client-scope finalizer settles every queued waiter with `closed`, which fails it with an `SqlError` "Database client closed" that is not an overload. This wakes uninterruptible waiters. Remaining timers end through the scope. Test: close the client with two queued waiters (one uninterruptible), and both waiters fail with the closed error.

R3-5 Failing-first fix. 9a/9b/9c each first assert the 65th read is pending (`pollUnsafe()` undefined after the 64 are admitted). On dev that assertion fails, because the read already failed. The grant-pinning test covers delayed-timer, equality (grant at exactly the deadline → expired), and grant at deadline − 1 ms then resume after the deadline (admitted, exact count).


R3-6 (supersedes the clock in R3-2) Deadline creation, pump checks, and the remaining-sleep calculation all use `Clock.monotonicTimeNanos` / `clock.monotonicTimeNanosUnsafe()`, as `acquired()` already does at `nodeSqliteClient.ts:1141-1146`.
R3-7 (completes R3-3) After `forkIn` returns the handle, the gate stores it and then rechecks the waiter state. If the waiter is already settled, it interrupts the handle there. Tests: settle before the timer starts, and settle after the timer's first step but before the handle is stored. Both end with no live timer fiber (the scope closes cleanly, and TestClock advanced past the deadline shows no late expiry effect).


## Revision 4 — audit r1 fixes

R4-1 Typed gate outcomes. The gate fails with `ReaderAdmissionOverloadError` (deadline expiry or fail-fast) or `ReaderAdmissionClosedError` (new class in readerAdmission.ts, scope close). The client hook maps by type:
```ts
Effect.mapError((cause) =>
  failed(cause, cause instanceof ReaderAdmissionOverloadError ? "Database reader overloaded" : "Database client closed", "acquire"))
```
`isReaderAdmissionOverload` stays true only for the overload class, so a closed client never triggers the writer fallback or reads as overload. Test R3-4 asserts `isReaderAdmissionOverload(closedFailure) === false`.

