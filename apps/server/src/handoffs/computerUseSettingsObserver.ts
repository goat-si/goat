import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as ServerSettings from "../serverSettings.ts";
import { HandoffError } from "@goat/contracts";

export const startComputerUseSettingsObserver = Effect.fn(
  "Handoffs.startComputerUseSettingsObserver",
)(function* (
  settings: ServerSettings.ServerSettingsService["Service"],
  observe: (apps: ReadonlyArray<string>, strict: boolean) => Effect.Effect<void, HandoffError>,
  invalidate: () => Effect.Effect<void, HandoffError>,
) {
  const changes = yield* settings.subscribeChanges;
  const observeNow = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    yield* observe(current.cuaAllowedApps, current.cuaStrictInputGuards);
  });
  yield* observeNow;
  yield* Effect.gen(function* () {
    yield* observeNow;
    yield* Stream.runForEach(changes, (snapshot) =>
      observe(snapshot.cuaAllowedApps, snapshot.cuaStrictInputGuards),
    );
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logError("Computer use settings observer failed", { cause }).pipe(
          Effect.andThen(
            invalidate().pipe(Effect.retry({ schedule: Schedule.spaced("1 second") })),
          ),
          Effect.andThen(Effect.fail(new HandoffError({ reason: "unavailable", cause }))),
        ),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second") }),
    Effect.forkScoped,
  );
});
