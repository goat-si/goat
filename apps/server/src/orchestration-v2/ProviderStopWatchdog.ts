import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/** Past adapters' own 10 s stop fallbacks. */
export const PROVIDER_INTERRUPT_TIMEOUT_MS = 15_000;

export const interruptWithWatchdog = Effect.fn("ProviderSessionManager.interruptWithWatchdog")(
  function* (
    runtime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "driver" | "interruptTurn">,
    input: ProviderAdapter.ProviderAdapterV2InterruptInput,
  ) {
    const rootResolved = yield* Deferred.make<void>();
    const identity = {
      driver: runtime.driver,
      providerThreadId: input.providerThread.id,
      providerTurnId: input.providerTurnId,
    };
    const watchdog = Deferred.await(rootResolved).pipe(
      Effect.timeoutOrElse({
        duration: PROVIDER_INTERRUPT_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
              ...identity,
              timeoutMs: PROVIDER_INTERRUPT_TIMEOUT_MS,
            }),
          ),
      }),
      Effect.andThen(Effect.sleep(PROVIDER_INTERRUPT_TIMEOUT_MS)),
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterInterruptError({
            ...identity,
            cause: "Provider Stop cleanup timed out after the root outcome was known.",
          }),
        ),
      ),
    );
    return yield* Effect.raceFirst(
      runtime.interruptTurn({
        ...input,
        onRootStopResolved: Deferred.succeed(rootResolved, undefined).pipe(Effect.asVoid),
      }),
      watchdog,
    );
  },
);
