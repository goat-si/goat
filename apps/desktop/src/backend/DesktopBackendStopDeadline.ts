import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { BACKEND_SPAWN_SETTLE_TIMEOUT } from "./DesktopBackendProcess.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as DesktopObservability from "../app/DesktopObservability.ts";

export const makeStopDeadline = Effect.fn("desktop.backendInstance.stop.deadline")(function* (
  startedAt: bigint,
  timeout: Duration.Duration | undefined,
  recordStop: DesktopObservability.DesktopBackendOutputLogShape["recordStop"],
) {
  const deadline = timeout
    ? Option.map(Duration.toNanos(timeout), (nanos) => startedAt + nanos)
    : Option.none();
  const remaining = Effect.fn("desktop.backendInstance.stop.remaining")(function* (
    budget: Duration.Duration,
  ) {
    if (Option.isNone(deadline)) return budget;
    const nanos = deadline.value - (yield* Clock.monotonicTimeNanos);
    return Duration.nanos(nanos > 0n ? nanos : 0n);
  });
  const reported = yield* Ref.make(false);
  const reportTimeout = Effect.fn("desktop.backendInstance.stop.reportTimeout")(function* (
    details: string,
  ) {
    const first = yield* Ref.modify(reported, (value) => [!value, true] as const);
    if (first) {
      const write = recordStop({ message: "backend stop timed out", level: "WARN", details });
      if (timeout) yield* Effect.forkDetach(write);
      else yield* write;
    }
  });
  return { remaining, reportTimeout };
});

export const closeRun = (
  run: {
    readonly scope: Scope.Closeable;
    readonly spawnReady: Deferred.Deferred<void>;
    readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  },
  onSpawnPending: Effect.Effect<void>,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<boolean> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Effect.gen(function* () {
    const settled = yield* Deferred.await(run.spawnReady).pipe(
      Effect.timeoutOption(BACKEND_SPAWN_SETTLE_TIMEOUT),
    );
    if (Option.isNone(settled)) yield* onSpawnPending;
    yield* Scope.close(run.scope, Exit.void);
    if (Option.isSome(settled)) yield* waitForFiber;
  });
  const timeout = options?.timeout;

  if (!timeout) {
    return close.pipe(Effect.as(true));
  }

  return Effect.forkDetach(close).pipe(
    Effect.flatMap((closeFiber) =>
      Fiber.await(closeFiber).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome)),
    ),
  );
};
