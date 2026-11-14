import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ChannelLedger from "../ChannelLedger.ts";
import { PlacementStarted } from "../channelDispatchFences.ts";

type HeldMethod =
  | "findIdentity"
  | "getRemoteWorker"
  | "isForwardPending"
  | "getTask"
  | "recordDelivery"
  | "releaseUnsentDeliveries";
type Ledger = ChannelLedger.ChannelLedger["Service"];
type Input<M extends HeldMethod> = Parameters<Ledger[M]>[0];
type Hold = { reached: Effect.Effect<void>; release: Effect.Effect<boolean> };

export class LedgerCallHolds extends Context.Service<
  LedgerCallHolds,
  {
    readonly holdNext: <M extends HeldMethod>(
      method: M,
      forInput?: (input: Input<M>) => boolean,
    ) => Effect.Effect<Hold>;
    readonly failNext: <M extends HeldMethod>(
      method: M,
      error: ChannelLedger.ChannelLedgerError,
      forInput?: (input: Input<M>) => boolean,
    ) => Effect.Effect<void>;
    readonly failEvery: <M extends HeldMethod>(
      method: M,
      error: ChannelLedger.ChannelLedgerError,
      forInput?: (input: Input<M>) => boolean,
    ) => Effect.Effect<{ readonly calls: Effect.Effect<number> }>;
  }
>()("goat/channels/testkit/dispatchRace/LedgerCallHolds") {
  static readonly layer = Layer.effect(
    LedgerCallHolds,
    Effect.gen(function* () {
      const ledger = yield* ChannelLedger.ChannelLedger;
      const observed: Record<
        HeldMethod,
        (input: never) => Effect.Effect<unknown, ChannelLedger.ChannelLedgerError>
      > = ledger;
      const methods: HeldMethod[] = [
        "findIdentity",
        "getRemoteWorker",
        "isForwardPending",
        "getTask",
        "recordDelivery",
        "releaseUnsentDeliveries",
      ];
      const originals = { ...observed };
      const releases = new Set<Deferred.Deferred<void>>();
      const pending = new Map<
        HeldMethod,
        Array<{
          matches: (input: never) => boolean;
          run: (input: never) => Effect.Effect<unknown, ChannelLedger.ChannelLedgerError>;
          persistent: boolean;
        }>
      >();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          for (const method of methods) {
            observed[method] = (input) =>
              Effect.suspend(() => {
                const queue = pending.get(method) ?? [];
                const index = queue.findIndex((entry) => entry.matches(input));
                if (index < 0) return originals[method](input);
                const entry = queue[index];
                if (entry !== undefined && !entry.persistent) queue.splice(index, 1);
                return entry === undefined ? originals[method](input) : entry.run(input);
              });
          }
        }),
        () =>
          Effect.gen(function* () {
            for (const method of methods) observed[method] = originals[method];
            yield* Effect.forEach(releases, (release) => Deferred.succeed(release, undefined), {
              discard: true,
            });
          }),
      );
      const enqueue = <M extends HeldMethod>(
        method: M,
        forInput: ((input: Input<M>) => boolean) | undefined,
        run: (input: never) => Effect.Effect<unknown, ChannelLedger.ChannelLedgerError>,
        persistent = false,
      ) => {
        const queue = pending.get(method) ?? [];
        queue.push({
          matches: (input) => forInput === undefined || forInput(input),
          run,
          persistent,
        });
        pending.set(method, queue);
      };
      return LedgerCallHolds.of({
        holdNext: Effect.fn("LedgerCallHolds.holdNext")(function* <M extends HeldMethod>(
          method: M,
          forInput?: (input: Input<M>) => boolean,
        ) {
          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          releases.add(release);
          enqueue(method, forInput, (input) =>
            Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(originals[method](input)),
            ),
          );
          return {
            reached: Deferred.await(reached),
            release: Deferred.succeed(release, undefined),
          };
        }),
        failNext: Effect.fn("LedgerCallHolds.failNext")(
          <M extends HeldMethod>(
            method: M,
            error: ChannelLedger.ChannelLedgerError,
            forInput?: (input: Input<M>) => boolean,
          ) =>
            Effect.sync(() => {
              enqueue(method, forInput, () => Effect.fail(error));
            }),
        ),
        failEvery: Effect.fn("LedgerCallHolds.failEvery")(
          <M extends HeldMethod>(
            method: M,
            error: ChannelLedger.ChannelLedgerError,
            forInput?: (input: Input<M>) => boolean,
          ) =>
            Effect.sync(() => {
              let count = 0;
              enqueue(
                method,
                forInput,
                () =>
                  Effect.suspend(() => {
                    count += 1;
                    return Effect.fail(error);
                  }),
                true,
              );
              return { calls: Effect.sync(() => count) };
            }),
        ),
      });
    }),
  );
}

/** Records the automatic placements a dispatch starts, so a test awaits their end, never polls. */
export const trackPlacements = () => {
  const started = new Set<Fiber.Fiber<unknown, unknown>>();
  return {
    observe: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(PlacementStarted, (fiber) =>
          Effect.sync(() => {
            started.add(fiber);
          }),
        ),
      ),
    /** The placements started since the last wait have ended; a wait that saw none is wrong. */
    settled: Effect.suspend(() => {
      const fibers = [...started];
      started.clear();
      return fibers.length === 0
        ? Effect.die("no automatic placement started since the last wait")
        : Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { discard: true });
    }),
  };
};
