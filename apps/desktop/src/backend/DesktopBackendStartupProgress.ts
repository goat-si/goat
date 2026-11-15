import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

const STALL = 60_000_000_000n;
const CEILING = 600_000_000_000n;

export const makeStartupProgress = Effect.fn("desktop.backendStartupProgress.make")(function* () {
  const started = yield* Clock.monotonicTimeNanos;
  const activity = yield* Ref.make(started);
  const ready = yield* Deferred.make<void>();
  const watch = Effect.fn("desktop.backendStartupProgress.watch")(function* (
    report: (reason: string) => Effect.Effect<void>,
    // While this holds at a deadline, both budgets start over instead of reporting.
    waiting: Effect.Effect<boolean> = Effect.succeed(false),
  ) {
    let since = started;
    while (true) {
      const now = yield* Clock.monotonicTimeNanos;
      const last = yield* Ref.get(activity);
      const remaining = (last + STALL < since + CEILING ? last + STALL : since + CEILING) - now;
      if (remaining > 0n) {
        const result = yield* Deferred.await(ready).pipe(
          Effect.timeoutOption(Duration.nanos(remaining)),
        );
        if (Option.isSome(result)) return;
      } else {
        yield* Effect.yieldNow;
        if (yield* Deferred.isDone(ready)) return;
        const current = yield* Clock.monotonicTimeNanos;
        if (yield* waiting) {
          since = current;
          yield* Ref.set(activity, current);
          continue;
        }
        const latest = yield* Ref.get(activity);
        if (current - since >= CEILING)
          return yield* report("The server was not ready after 10 minutes.");
        if (current - latest >= STALL)
          return yield* report("The server printed nothing for 60 seconds.");
      }
    }
  });
  return {
    activity: Clock.monotonicTimeNanos.pipe(Effect.flatMap((now) => Ref.set(activity, now))),
    ready: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
    watch,
  };
});
