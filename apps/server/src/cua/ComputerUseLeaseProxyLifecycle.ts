import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { LeaseProxyDriver } from "./ComputerUseLeaseProxy.ts";

export interface Running {
  readonly driver: LeaseProxyDriver;
  readonly scope: Scope.Closeable;
  readonly connectionId: string;
}

/** Cutoff and acquisition may overlap newer handbacks; only their own revision can publish. */
export const makeLeaseProxyLifecycle = Effect.fn("ComputerUseLeaseProxy.makeLifecycle")(function* <
  E,
>(options: {
  readonly connectionId: string;
  readonly startDriver: Effect.Effect<LeaseProxyDriver, E, Scope.Scope>;
  readonly active: () => boolean;
  readonly deadline: () => number;
  readonly onStarted: (current: Running) => Effect.Effect<void>;
}) {
  const scope = yield* Effect.scope;
  let current: Running | undefined;
  let revision = 0;
  let generation = 0;
  return {
    get current() {
      return current;
    },
    interrupt() {
      const token = ++revision;
      const previous = current;
      current = undefined;
      return { token, current: previous };
    },
    start: Effect.fn("ComputerUseLeaseProxy.startDriver")(function* (expected = revision) {
      if (expected !== revision || !options.active() || current !== undefined) return;
      const token = ++revision;
      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const child = yield* Scope.fork(scope);
          if (token !== revision || !options.active()) return yield* Scope.close(child, Exit.void);
          const acquired = yield* options.startDriver.pipe(
            Scope.provide(child),
            restore,
            Effect.exit,
          );
          if (Exit.isFailure(acquired)) {
            yield* Scope.close(child, acquired);
            // A superseded acquisition's failure cannot end the newer lifecycle.
            if (token === revision && options.active())
              return yield* Effect.failCause(acquired.cause);
            return;
          }
          const driver = acquired.value;
          const now = yield* Clock.currentTimeMillis;
          if (
            token !== revision ||
            !options.active() ||
            current !== undefined ||
            now >= options.deadline()
          ) {
            yield* driver.kill;
            return yield* Scope.close(child, Exit.void);
          }
          const next = {
            driver,
            scope: child,
            connectionId: `${options.connectionId}:${generation++}`,
          };
          current = next;
          yield* options.onStarted(next);
        }),
      );
    }),
  };
});
