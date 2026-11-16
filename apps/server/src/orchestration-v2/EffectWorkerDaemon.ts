// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { ClaimSlot } from "./EffectExecutionFences.ts";
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
// A provider request can go unanswered indefinitely. After this wait the slot detaches the
// execution, which keeps fencing its own thread, and claims other work. Each lane detaches at
// most as many executions as it has slots; past that the slot keeps waiting.
const EFFECT_WORKER_SLOT_WAIT = Duration.seconds(30);

export const runDaemonWithOptions = (options: OrchestrationEffectDaemonOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* OrchestrationEffectWorkerV2;
      // Shutdown interrupts in-flight executions together, as the slots themselves are.
      const scope = yield* Scope.fork(yield* Effect.scope, "parallel");
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
          detachCap: number,
        ) =>
          Effect.gen(function* () {
            while (true) {
              const slot: Context.Service.Shape<typeof ClaimSlot> = {};
              const attempt = yield* runOnce.pipe(
                Effect.map((worked) => (worked ? ("worked" as const) : ("idle" as const))),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Orchestration effect worker failed", cause).pipe(
                    Effect.as("failed" as const),
                  ),
                ),
                Effect.provideService(ClaimSlot, slot),
                Effect.forkIn(scope, { startImmediately: true }),
              );
              let outcome: "worked" | "idle" | "failed" | undefined;
              while (outcome === undefined) {
                const joined = yield* Fiber.join(attempt).pipe(
                  Effect.timeoutOption(EFFECT_WORKER_SLOT_WAIT),
                );
                if (Option.isSome(joined)) outcome = joined.value;
                else if (
                  slot.current !== undefined &&
                  (yield* slot.current.fences.detach(slot.current.claim, detachCap))
                ) {
                  yield* Effect.logWarning("orchestration-v2.effect-execution-detached", {
                    effectId: slot.current.claim.id,
                    effectType: slot.current.claim.request.type,
                  });
                  outcome = "worked";
                }
              }
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

      const startSlots = Math.max(2, Math.floor(NodeOS.availableParallelism() / 2));
      return yield* Effect.all(
        [
          ...Array.from({ length: concurrency }, () =>
            runWorker(
              worker.runGeneralOnce,
              worker.nextGeneralClaimableAt,
              worker.awaitWork,
              concurrency,
            ),
          ),
          ...Array.from({ length: startSlots }, () =>
            runWorker(
              worker.runStartOnce,
              worker.nextStartClaimableAt,
              worker.awaitStartWork,
              startSlots,
            ),
          ),
          runWorker(
            worker.runControlOnce,
            worker.nextControlClaimableAt,
            worker.awaitControlWork,
            1,
          ),
          runWorker(
            worker.runCleanupOnce,
            worker.nextCleanupClaimableAt,
            worker.awaitCleanupWork,
            1,
          ),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  );

export const runDaemon = runDaemonWithOptions();
