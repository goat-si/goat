import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { OpenCodeRuntimeError } from "./OpenCodeRuntime.ts";
import { OPENCODE_PROVIDER } from "./adapterProtocol.ts";
import type { ActiveOpenCodeTurn } from "./adapterState.ts";

export const STOP_CONFIRM_TIMEOUT_MS = 10_000;

export type OpenCodeStopDeadline = Deferred.Deferred<
  never,
  ProviderAdapter.ProviderAdapterInterruptTimeoutError
>;

export const runOpenCodeStop = Effect.fn("OpencodeAdapter.runStop")(function* <E>(
  scope: Scope.Scope,
  stop: (deadline: OpenCodeStopDeadline) => Effect.Effect<void, E>,
) {
  const deadline = yield* Deferred.make<
    never,
    ProviderAdapter.ProviderAdapterInterruptTimeoutError
  >();
  // Keep the lifecycle permit and child attribution until cleanup finishes, even after Stop returns.
  const cleanup = yield* Effect.forkIn(stop(deadline), scope);
  return yield* Effect.raceFirst(Deferred.await(deadline), Fiber.join(cleanup)).pipe(
    Effect.onInterrupt(() => Fiber.interrupt(cleanup)),
  );
});

export const resolveOpenCodeRootStop = Effect.fn("OpencodeAdapter.resolveRootStop")(function (
  abort: Effect.Effect<unknown, Cause.TimeoutError | OpenCodeRuntimeError>,
  turn: ActiveOpenCodeTurn,
  input: ProviderAdapter.ProviderAdapterV2InterruptInput,
  deadline: OpenCodeStopDeadline,
) {
  return abort.pipe(
    Effect.catch(
      (
        cause,
      ): Effect.Effect<
        void,
        OpenCodeRuntimeError | ProviderAdapter.ProviderAdapterInterruptTimeoutError
      > => {
        if (turn.finalized) return Effect.void;
        turn.interrupted = false;
        if (cause._tag !== "TimeoutError") return Effect.fail(cause);
        const timeout = new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
          driver: OPENCODE_PROVIDER,
          providerThreadId: input.providerThread.id,
          providerTurnId: input.providerTurnId,
          timeoutMs: STOP_CONFIRM_TIMEOUT_MS,
        });
        return Deferred.fail(deadline, timeout).pipe(Effect.andThen(Effect.fail(timeout)));
      },
    ),
    Effect.ensuring(input.onRootStopResolved ?? Effect.void),
  );
});
