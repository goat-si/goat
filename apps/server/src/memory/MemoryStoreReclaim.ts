import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Store from "./MemoryStore.ts";
import { MemoryCapacityError, Transaction } from "./store/StoreModel.ts";

export type MemoryStoreReclaimOutcome = "completed" | "unsupported" | "failed";
export interface MemoryStoreReclaimResult {
  readonly outcome: MemoryStoreReclaimOutcome;
  /** Logical bytes the pressure rule could still remove after this reclaim. */
  readonly eligibleLogicalBytes: number;
  readonly nextEligibleAtMs: number | null;
}
interface HubReclaim {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly reclaim: Effect.Effect<unknown, { readonly _tag: string }>;
}

/** One automatic cleanup before a full store refuses a local write. */
export class MemoryStoreReclaim extends Context.Service<
  MemoryStoreReclaim,
  {
    /** Callers that arrive while a reclaim runs share its result; later callers start another. */
    readonly reclaim: (environmentId: M.EnvironmentId) => Effect.Effect<MemoryStoreReclaimResult>;
    /** The hub composition binds its compactor once this environment hosts a ready hub. */
    readonly bindHub: (hub: Option.Option<HubReclaim>) => Effect.Effect<void>;
  }
>()("goat/memory/MemoryStoreReclaim") {}

export const makeStoreReclaim = Effect.fnUntraced(function* (
  store: Store.MemoryStore["Service"],
  recordSample: (
    environmentId: M.EnvironmentId,
    measured: Effect.Success<ReturnType<Store.MemoryStore["Service"]["measureAllocation"]>>,
  ) => Effect.Effect<unknown, { readonly _tag: string }>,
) {
  const hub = yield* Ref.make(Option.none<HubReclaim>());
  const inFlight = yield* Ref.make(Option.none<Deferred.Deferred<MemoryStoreReclaimResult>>());
  const failed = (stage: string) => (error: { readonly _tag: string }) =>
    Effect.logWarning("Memory store reclaim failed", { stage, errorTag: error._tag }).pipe(
      Effect.as(false),
    );
  const failedResult: MemoryStoreReclaimResult = {
    outcome: "failed",
    eligibleLogicalBytes: 0,
    nextEligibleAtMs: null,
  };
  const reclaim = Effect.fn("MemoryStoreReclaim.reclaim")((environmentId: M.EnvironmentId) =>
    // Claiming the slot and registering its release happen without an interruption point, so an
    // interrupted owner always settles its waiters and frees the slot for the next reclaim.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const own = yield* Deferred.make<MemoryStoreReclaimResult>();
        const running = yield* Ref.modify(
          inFlight,
          (
            current,
          ): readonly [
            Option.Option<Deferred.Deferred<MemoryStoreReclaimResult>>,
            Option.Option<Deferred.Deferred<MemoryStoreReclaimResult>>,
          ] => (Option.isSome(current) ? [current, current] : [Option.none(), Option.some(own)]),
        );
        if (Option.isSome(running)) return yield* restore(Deferred.await(running.value));
        return yield* restore(reclaimNow(environmentId)).pipe(
          Effect.tap((result) => Deferred.succeed(own, result)),
          Effect.ensuring(
            Deferred.succeed(own, failedResult).pipe(
              Effect.andThen(Ref.set(inFlight, Option.none())),
            ),
          ),
        );
      }),
    ),
  );
  const reclaimNow = Effect.fnUntraced(function* (environmentId: M.EnvironmentId) {
    const bound = yield* Ref.get(hub);
    const compacted = Option.isNone(bound)
      ? true
      : yield* bound.value.reclaim.pipe(Effect.as(true), Effect.catch(failed("compact")));
    // The admission figure is only as fresh as the last measurement, so remeasure either way.
    const measured = yield* store.measureAllocation().pipe(
      Effect.flatMap((sample) => recordSample(environmentId, sample)),
      Effect.as(true),
      Effect.catch(failed("measure")),
    );
    if (Option.isNone(bound))
      return {
        outcome: measured ? "unsupported" : "failed",
        eligibleLogicalBytes: 0,
        nextEligibleAtMs: null,
      } satisfies MemoryStoreReclaimResult;
    const eligibility = yield* store
      .transact(
        store.pressureEligibilityTx(bound.value.memorySpaceId, yield* Clock.currentTimeMillis),
      )
      .pipe(Effect.option);
    return {
      outcome: compacted && measured && Option.isSome(eligibility) ? "completed" : "failed",
      eligibleLogicalBytes: Option.isSome(eligibility) ? eligibility.value.eligibleLogicalBytes : 0,
      nextEligibleAtMs: Option.isSome(eligibility) ? eligibility.value.nextEligibleAtMs : null,
    } satisfies MemoryStoreReclaimResult;
  });
  const bindHub = Effect.fn("MemoryStoreReclaim.bindHub")((next: Option.Option<HubReclaim>) =>
    Ref.set(hub, next),
  );
  return MemoryStoreReclaim.of({ reclaim, bindHub });
});

const isCapacityError = Schema.is(MemoryCapacityError);

/**
 * Effect.fn post-processor for a local write that owns its transaction: a refusal by the store
 * budget (raised only for local intents) runs one reclaim and the whole write once more. Inside a
 * caller's transaction it does nothing, so the outermost write is the one that retries. The retry
 * re-reads receipts, so a concurrent duplicate of an operation id is answered, not applied twice.
 */
export const withStoreReclaim =
  (environmentId: M.EnvironmentId) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    self.pipe(
      Effect.catch((error: E) =>
        Effect.gen(function* () {
          if (
            !isCapacityError(error) ||
            error.budget !== "store" ||
            Option.isSome(yield* Effect.serviceOption(Transaction))
          )
            return yield* Effect.fail(error);
          const service = yield* Effect.serviceOption(MemoryStoreReclaim);
          if (Option.isNone(service)) return yield* error;
          const result = yield* service.value.reclaim(environmentId);
          return yield* self.pipe(
            Effect.mapError((retry: E) =>
              isCapacityError(retry) && retry.budget === "store"
                ? (new MemoryCapacityError({
                    ...retry,
                    reclaim: result.outcome,
                    reclaimable: result.eligibleLogicalBytes,
                    ...(result.nextEligibleAtMs === null
                      ? {}
                      : { nextEligibleAtMs: result.nextEligibleAtMs }),
                  }) as E)
                : retry,
            ),
          );
        }),
      ),
    );
