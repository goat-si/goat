import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

export const supervise = Effect.fn("BackgroundSupervision.supervise")(function* <E, R>(
  name: string,
  attempt: () => Effect.Effect<unknown, E, R>,
  options: { readonly restartOnSuccess?: boolean } = {},
) {
  let delayMs = 1_000;
  let failed = false;
  while (true) {
    const exit = yield* Effect.exit(Effect.scoped(Effect.suspend(attempt)));
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
    if (Exit.isSuccess(exit) && options.restartOnSuccess === false) {
      if (failed) yield* Effect.logInfo("Background operation recovered", { operation: name });
      return;
    }
    if (!failed) {
      yield* Effect.logWarning("Background operation stopped; retrying", {
        operation: name,
        outcome: Exit.isSuccess(exit) ? "ended" : "failed",
      });
      failed = true;
    }
    yield* Effect.sleep(delayMs);
    delayMs = Math.min(30_000, delayMs * 2);
  }
});

export const runResumableReactor = Effect.fn("BackgroundSupervision.runResumableReactor")(
  function* <A extends { readonly sequence: number }, E, R, E2, R2>(
    name: string,
    initialSequence: number,
    open: (afterSequence: number) => Stream.Stream<A, E, R>,
    handle: (value: A) => Effect.Effect<unknown, E2, R2>,
  ) {
    let sequence = initialSequence;
    yield* supervise(name, () =>
      open(sequence).pipe(
        Stream.runForEach((value) =>
          handle(value).pipe(
            Effect.andThen(
              Effect.sync(() => {
                sequence = value.sequence;
              }),
            ),
          ),
        ),
      ),
    );
  },
);
