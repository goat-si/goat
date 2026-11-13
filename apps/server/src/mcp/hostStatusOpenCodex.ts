import type { OpenCodexInventorySnapshot } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

const OPENCODEX_READ_WAIT = Duration.seconds(2);
type Pending = Deferred.Deferred<Exit.Exit<OpenCodexInventorySnapshot>>;
type ReaderState = {
  last: OpenCodexInventorySnapshot | undefined;
  inflight: Pending | undefined;
  fresh: boolean;
};
type Choice =
  | { readonly cached: OpenCodexInventorySnapshot }
  | {
      readonly pending: Pending;
      readonly mine: boolean;
      readonly last: OpenCodexInventorySnapshot | undefined;
    };

export const makeHostStatusOpenCodex = Effect.fn("HostStatus.makeOpenCodexReader")(function* (
  read: Effect.Effect<OpenCodexInventorySnapshot>,
  scope: Scope.Scope,
) {
  const state = yield* Ref.make<ReaderState>({
    last: undefined,
    inflight: undefined,
    fresh: false,
  });
  const readOpenCodex = Effect.fn("HostStatus.readOpenCodex")(function* () {
    const selected = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fresh = yield* Deferred.make<Exit.Exit<OpenCodexInventorySnapshot>>();
        const choice = yield* Ref.modify(state, (current): readonly [Choice, ReaderState] => {
          if (current.fresh && current.last !== undefined && current.inflight === undefined)
            return [{ cached: current.last } as const, { ...current, fresh: false }] as const;
          if (current.inflight !== undefined)
            return [
              { pending: current.inflight, mine: false, last: current.last } as const,
              current,
            ] as const;
          return [
            { pending: fresh, mine: true, last: current.last } as const,
            { ...current, inflight: fresh },
          ] as const;
        });
        if ("cached" in choice) return choice;
        if (choice.mine)
          yield* Effect.interruptible(read).pipe(
            Effect.onExit((exit) =>
              Ref.update(state, (current) => ({
                last: Exit.isSuccess(exit) ? exit.value : current.last,
                inflight: undefined,
                fresh: Exit.isSuccess(exit) ? true : current.fresh,
              })).pipe(
                Effect.andThen(Deferred.succeed(fresh, exit)),
                Effect.andThen(
                  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.logWarning("OpenCodex inventory read failed.", exit.cause)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkIn(scope),
          );
        return choice;
      }),
    );
    if ("cached" in selected) return selected.cached;
    const answer =
      selected.last === undefined
        ? Option.some(yield* Deferred.await(selected.pending))
        : yield* Deferred.await(selected.pending).pipe(Effect.timeoutOption(OPENCODEX_READ_WAIT));
    if (Option.isSome(answer) && Exit.isSuccess(answer.value)) {
      const snapshot = answer.value.value;
      yield* Ref.update(state, (current) =>
        current.last === snapshot ? { ...current, fresh: false } : current,
      );
      return snapshot;
    }
    if (selected.last !== undefined) return { ...selected.last, slow: true as const };
    if (Option.isSome(answer)) return yield* answer.value;
    return yield* Effect.die("OpenCodex inventory read did not complete");
  });
  return readOpenCodex();
});
