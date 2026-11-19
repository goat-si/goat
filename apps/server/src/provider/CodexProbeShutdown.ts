import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export const waitForCodexStartupWork = <E, R>(
  busy: Effect.Effect<boolean, E, R>,
  close: Effect.Effect<void>,
) =>
  busy.pipe(
    Effect.orElseSucceed(() => false),
    Effect.repeat({ schedule: Schedule.spaced("500 millis"), while: (working) => working }),
    Effect.timeoutOption("1 minute"),
    Effect.ensuring(close),
    Effect.asVoid,
  );
