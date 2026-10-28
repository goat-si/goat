import type { ServerSettingsError, StorageCleanupReport } from "@goat/contracts";
import { makeDrainableWorker } from "@goat/shared/DrainableWorker";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as AutomationHold from "./automationHold.ts";

export const makeStorageCleanupWorker = Effect.fn("StorageCleanup.makeWorker")(function* <R>(
  sweep: (
    trigger: "automatic" | "manual",
  ) => Effect.Effect<StorageCleanupReport, ServerSettingsError, R>,
) {
  const automationHold = yield* AutomationHold.AutomationHold;
  let closed = false;
  let pendingManual: Deferred.Deferred<StorageCleanupReport, ServerSettingsError> | undefined;
  const worker = yield* makeDrainableWorker(
    (_wake: void) =>
      Effect.gen(function* () {
        const completion = pendingManual;
        pendingManual = undefined;
        if (completion === undefined && (yield* automationHold.current) !== null) return;
        const trigger = completion === undefined ? "automatic" : "manual";
        yield* Effect.suspend(() => sweep(trigger)).pipe(
          Effect.onExit((exit) =>
            completion !== undefined ? Deferred.done(completion, exit) : Effect.void,
          ),
          Effect.catchCause((cause) =>
            completion === undefined
              ? Effect.logWarning("storage cleanup failed", { cause })
              : Effect.void,
          ),
        );
      }),
    { capacity: 1 },
  );
  // A full slot already promises a fresh sweep; requests carry no per-event state.
  const requestSweep = worker.enqueue(undefined).pipe(Effect.asVoid);
  yield* Effect.addFinalizer(() => {
    closed = true;
    const completion = pendingManual;
    pendingManual = undefined;
    return completion ? Deferred.interrupt(completion) : Effect.void;
  });
  const runNow = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (closed) return yield* Effect.interrupt;
      const completion = (pendingManual ??= Deferred.makeUnsafe<
        StorageCleanupReport,
        ServerSettingsError
      >());
      if ((yield* worker.enqueue(undefined)) === "closed") {
        pendingManual = undefined;
        yield* Deferred.interrupt(completion);
      }
      return yield* restore(Deferred.await(completion));
    }),
  );
  return { runNow, requestSweep, drain: worker.drain };
});
