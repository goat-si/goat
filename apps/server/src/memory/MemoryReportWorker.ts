import type * as M from "@goat/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@goat/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as MemoryReportAdapter from "./MemoryReportAdapter.ts";
import * as MemoryService from "./MemoryService.ts";
import * as MemoryStore from "./MemoryStore.ts";

const BATCH_SIZE = 8;
const CLAIM_MS = 60_000;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 600_000;
const retryDelay = (attempt: number) =>
  Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1));

export class MemoryReportWorker extends Context.Service<
  MemoryReportWorker,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("goat/memory/MemoryReportWorker") {}

const make = Effect.gen(function* () {
  const service = yield* MemoryService.MemoryService;
  const store = yield* MemoryStore.MemoryStore;
  const adapter = yield* MemoryReportAdapter.MemoryReportAdapter;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const owner = yield* environment.getEnvironmentId;
  const sweepLock = yield* Semaphore.make(1);
  const started = yield* Ref.make(false);
  const queue = yield* Ref.make<DrainableWorker<void> | undefined>(undefined);

  const deliver = (report: M.MemoryReportDelivery, claimUntil: number) =>
    Effect.gen(function* () {
      const delivery = yield* adapter.deliver(report);
      // False is a stale lease: do not try a second mutation or invent delivery evidence.
      yield* service.acknowledgeClaimedReport({ delivery, owner, claimUntil });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const failureCode =
            error._tag === "MemoryReportAdapterError" ? error.code : "storage_failed";
          yield* service.deferClaimedReport({
            reportId: report.reportId,
            owner,
            claimUntil,
            failureCode,
            nextAttemptAt: now + retryDelay(report.automaticAttempts ?? 1),
          });
        }),
      ),
    );

  const sweep = Effect.gen(function* () {
    let now = yield* Clock.currentTimeMillis;
    yield* service.normalizeExpiredReports(now);
    const maintenanceAt = yield* service.nextReportMaintenanceAt;
    if (maintenanceAt !== null && maintenanceAt <= now)
      yield* service.purgeDeliveredReportDetails({ now, limit: 256 });
    for (let index = 0; index < BATCH_SIZE; index++) {
      now = yield* Clock.currentTimeMillis;
      const claimUntil = now + CLAIM_MS;
      // Claim immediately before each call, so slow preceding deliveries spend no other lease.
      const reports = yield* service.acquireReports({ owner, now, until: claimUntil, limit: 1 });
      const report = reports[0];
      if (!report) break;
      yield* deliver(report, claimUntil);
    }
  }).pipe(sweepLock.withPermits(1));

  const start = Effect.fn("MemoryReportWorker.start")(function* () {
    if (yield* Ref.getAndSet(started, true)) return;
    yield* Effect.addFinalizer(() => Ref.set(started, false));
    const scope = yield* Effect.scope;
    const queued = yield* Ref.make(false);
    const timer = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined);
    const cancelTimer = Effect.gen(function* () {
      const previous = yield* Ref.getAndSet(timer, undefined);
      if (previous) yield* Fiber.interrupt(previous);
    });
    const worker: DrainableWorker<void> = yield* makeDrainableWorker(() =>
      Effect.gen(function* () {
        yield* Ref.set(queued, false);
        yield* cancelTimer;
        const succeeded = yield* sweep.pipe(
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("Memory report delivery deferred", { code: "storage_failed" }).pipe(
              Effect.as(false),
            ),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        const next = yield* Effect.all([
          service.nextReportWakeAt(now),
          service.nextReportMaintenanceAt,
        ]).pipe(
          Effect.map((times) => times.filter((time): time is number => time !== null)),
          Effect.catch(() => Effect.succeed([now + RETRY_MIN_MS])),
        );
        if (!succeeded) next.push(now + RETRY_MIN_MS);
        if (next.length) {
          const at = Math.max(Math.min(...next), succeeded ? now : now + RETRY_MIN_MS);
          const scheduled = yield* Effect.sleep(Math.max(0, at - now)).pipe(
            Effect.andThen(wake),
            Effect.forkIn(scope),
          );
          yield* Ref.set(timer, scheduled);
        }
      }),
    );
    const wake = Ref.getAndSet(queued, true).pipe(
      Effect.flatMap((already) => (already ? Effect.void : worker.enqueue(undefined))),
    );
    yield* Ref.set(queue, worker);
    yield* Effect.addFinalizer(() => Ref.set(queue, undefined));
    const wakes = yield* store.subscribeWake;
    yield* Stream.runForEach(wakes, () => wake).pipe(Effect.forkScoped);
    yield* wake;
  });

  const drain = Effect.gen(function* () {
    const worker = yield* Ref.get(queue);
    if (worker) {
      yield* worker.enqueue(undefined);
      yield* worker.drain;
    } else {
      yield* sweep.pipe(
        Effect.catch(() =>
          Effect.logWarning("Memory report delivery deferred", { code: "storage_failed" }),
        ),
      );
    }
  });
  return MemoryReportWorker.of({ start, drain });
});
export const layer = Layer.effect(MemoryReportWorker, make);
