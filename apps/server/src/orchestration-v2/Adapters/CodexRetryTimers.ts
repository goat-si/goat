import type { ProviderTurnId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export function makeCodexRetryTimers(scope: Scope.Scope) {
  const timers = new Map<
    ProviderTurnId,
    Fiber.Fiber<void, ProviderAdapter.ProviderAdapterProtocolError>
  >();
  const cancel = Effect.fn("CodexRetryTimers.cancel")(function* (id: ProviderTurnId) {
    const timer = timers.get(id);
    timers.delete(id);
    if (timer !== undefined) yield* Fiber.interrupt(timer);
  });
  const start = Effect.fn("CodexRetryTimers.start")(function* (
    id: ProviderTurnId,
    work: Effect.Effect<void, ProviderAdapter.ProviderAdapterProtocolError>,
  ) {
    yield* cancel(id);
    const timer = yield* work.pipe(
      Effect.delay("10 minutes"),
      Effect.ensuring(
        Effect.sync(() => {
          if (timers.get(id) === timer) timers.delete(id);
        }),
      ),
      Effect.forkIn(scope),
    );
    timers.set(id, timer);
  });
  return { cancel, start };
}
