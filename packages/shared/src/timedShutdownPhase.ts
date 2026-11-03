import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export const timedShutdownPhase = Effect.fn("serverRuntimeStartup.timedShutdownPhase")(function* <
  A,
  E,
  R,
>(
  phase: string,
  effect: Effect.Effect<A, E, R>,
  details?: (value: A) => Readonly<Record<string, unknown>>,
) {
  const start = yield* Clock.monotonicTimeNanos;
  yield* Effect.logInfo("Server shutdown phase started", { phase });
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const durationMs = Number(((yield* Clock.monotonicTimeNanos) - start) / 1_000_000n);
        const outcome = Exit.isSuccess(exit)
          ? "success"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failure";
        yield* Effect.logInfo("Server shutdown phase finished", {
          phase,
          durationMs,
          outcome,
          ...(Exit.isSuccess(exit) && details ? details(exit.value) : {}),
        });
      }),
    ),
  );
});
