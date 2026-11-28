import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type * as KeyedLock from "@goat/shared/KeyedLock";
import { forkParked, ServerCommandReady } from "../serverActivation.ts";

export const parkDispatchRecovery = Effect.fn("RemoteDispatchCoordinator.parkRecovery")(function* <
  E,
  R,
>(options: {
  readonly ids: ReadonlyArray<string>;
  readonly awaitHold: Effect.Effect<void>;
  readonly locks: KeyedLock.KeyedLock<string>;
  readonly load: (
    id: string,
  ) => Effect.Effect<
    { readonly state: string; readonly launched_run_id: string | null } | null,
    E,
    R
  >;
  readonly start: (
    id: string,
    wait: boolean,
    interrupt: boolean,
    onlyUnowned: boolean,
  ) => Effect.Effect<void>;
}): Effect.fn.Return<void, never, R | Scope.Scope> {
  const ready = yield* ServerCommandReady;
  yield* forkParked(
    ready.pipe(
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.andThen(options.awaitHold),
      Effect.andThen(
        Effect.forEach(
          options.ids,
          (id) =>
            options.locks.withLock(
              id,
              Effect.gen(function* () {
                const current = yield* options.load(id);
                if (current?.state === "running")
                  yield* options.start(id, current.launched_run_id === null, false, true);
              }),
            ),
          { discard: true },
        ),
      ),
    ),
  );
});
