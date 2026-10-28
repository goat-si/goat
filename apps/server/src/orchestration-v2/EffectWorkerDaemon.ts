import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  OrchestrationEffectWorkerV2,
  type OrchestrationEffectWorkerV2Shape,
} from "./EffectWorker.ts";

export interface OrchestrationEffectDaemonOptions {
  readonly concurrency?: number;
  readonly livenessPollIntervalMs?: number;
}

const DEFAULT_EFFECT_WORKER_CONCURRENCY = 4;
const DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS = 30_000;

export const runDaemonWithOptions = (options: OrchestrationEffectDaemonOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* OrchestrationEffectWorkerV2;
      const requestedConcurrency = options.concurrency ?? DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.floor(requestedConcurrency))
        : DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const requestedLivenessPollIntervalMs =
        options.livenessPollIntervalMs ?? DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      const livenessPollIntervalMs = Number.isFinite(requestedLivenessPollIntervalMs)
        ? Math.max(1, Math.floor(requestedLivenessPollIntervalMs))
        : DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      // Notifications wake promptly; availableAt persists retry timing, and liveness polling recovers missed wakeups.
      yield* worker.configureConcurrency(concurrency);
      const runWorker = Effect.fn("EffectWorker.runLane")(
        (
          runOnce: OrchestrationEffectWorkerV2Shape["runOnce"],
          nextAvailable: OrchestrationEffectWorkerV2Shape["nextClaimableAt"],
          awaitWork: Effect.Effect<void>,
        ) =>
          Effect.gen(function* () {
            while (true) {
              const outcome = yield* runOnce.pipe(
                Effect.map((worked) => (worked ? ("worked" as const) : ("idle" as const))),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Orchestration effect worker failed", cause).pipe(
                    Effect.as("failed" as const),
                  ),
                ),
              );
              if (outcome === "worked") {
                yield* Effect.yieldNow;
                continue;
              }
              if (outcome === "failed") {
                // Failed claims can leave overdue rows; cool off instead of rescheduling at the one-millisecond floor.
                yield* Effect.sleep(Duration.millis(Math.min(1_000, livenessPollIntervalMs)));
                continue;
              }

              const nextClaimableAt = yield* nextAvailable.pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "Failed to read the next orchestration effect deadline",
                    cause,
                  ).pipe(Effect.as(Option.none<DateTime.Utc>())),
                ),
              );
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              const sleepMs = Option.match(nextClaimableAt, {
                onNone: () => livenessPollIntervalMs,
                onSome: (availableAt) => {
                  const untilAvailable = DateTime.toEpochMillis(availableAt) - now;
                  return Math.min(livenessPollIntervalMs, untilAvailable > 0 ? untilAvailable : 25);
                },
              });
              yield* Effect.raceFirst(
                awaitWork.pipe(Effect.as("notified" as const)),
                Effect.sleep(Duration.millis(sleepMs)).pipe(Effect.as("scheduled" as const)),
              );
            }
          }),
      );

      return yield* Effect.all(
        [
          ...Array.from({ length: concurrency }, () =>
            runWorker(worker.runGeneralOnce, worker.nextGeneralClaimableAt, worker.awaitWork),
          ),
          runWorker(worker.runControlOnce, worker.nextControlClaimableAt, worker.awaitControlWork),
          runWorker(worker.runCleanupOnce, worker.nextCleanupClaimableAt, worker.awaitCleanupWork),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  );

export const runDaemon = runDaemonWithOptions();
