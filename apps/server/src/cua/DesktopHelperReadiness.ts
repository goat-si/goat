import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

export const desktopHelperReadiness = Effect.map(
  DesktopTelemetryReceiver.DesktopTelemetryReceiver,
  (receiver) =>
    Effect.gen(function* () {
      const { status } = yield* receiver.health;
      if (status === "stopped" || status === "unavailable") return Option.none();
      return Option.map(yield* receiver.cuaReadiness, ({ readiness, signals }) => ({
        readiness,
        signals,
      }));
    }),
);
