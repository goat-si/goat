import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";

export const retryDelayMs = Effect.fn("RetryJitter.delayMs")(function* (
  ceilingMs: number,
  deadlineMs?: number,
) {
  const random = yield* Random.next;
  const delayMs = Math.round(ceilingMs * (0.5 + random * 0.5));
  return deadlineMs === undefined
    ? delayMs
    : Math.max(0, Math.min(delayMs, deadlineMs - (yield* Clock.currentTimeMillis)));
});

export const repairSchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    retryDelayMs(Math.min(30_000, Duration.toMillis(duration))),
  ),
);
