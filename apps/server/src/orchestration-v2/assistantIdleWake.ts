import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export const makeAssistantIdleWake = Effect.fn("assistantIdleWake.make")(function* () {
  const ticks = yield* Queue.dropping<{ readonly type: "idle_flush"; readonly at: number }>(1);
  let wake: { readonly at: number; readonly fiber: Fiber.Fiber<void> } | undefined;
  let closed = false;
  // Called for each streaming snapshot; the ingestion boundary already has a span.
  const schedule = Effect.fnUntraced(function* (at: number | null) {
    if (closed || at === null || (wake !== undefined && wake.at <= at)) return;
    if (wake !== undefined) yield* Fiber.interrupt(wake.fiber);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const fiber = yield* Effect.sleep(Duration.millis(Math.max(0, at - now))).pipe(
      Effect.andThen(Queue.offer(ticks, { type: "idle_flush", at })),
      Effect.asVoid,
      Effect.forkDetach,
    );
    wake = { at, fiber };
  });
  const fired = (now: number) => {
    if (wake !== undefined && wake.at <= now) wake = undefined;
  };
  const close = Effect.suspend(() => {
    closed = true;
    const current = wake;
    wake = undefined;
    return current === undefined ? Effect.void : Fiber.interrupt(current.fiber).pipe(Effect.asVoid);
  });
  return { events: Stream.fromQueue(ticks), schedule, fired, close };
});
