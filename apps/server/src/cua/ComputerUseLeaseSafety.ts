import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import type { ComputerUseDetection } from "./ComputerUseLeases.ts";
import { honoredSignals } from "./ComputerUsePrivateMode.ts";
import * as LinuxFrameSource from "./linuxFrames/LinuxFrameSource.ts";
import * as LinuxHelperHost from "./linuxHelperHost/LinuxHelperHost.ts";

export const makeLeaseSafety = Effect.fn("ComputerUseLeaseSafety.make")(function* (
  changed: Effect.Effect<void>,
) {
  const desktop = yield* Effect.serviceOption(DesktopTelemetryReceiver.DesktopTelemetryReceiver);
  const linuxFrames = yield* Effect.serviceOption(LinuxFrameSource.LinuxFrameSource);
  const linuxHelper = yield* Effect.serviceOption(LinuxHelperHost.LinuxHelperHost);
  const readinessReport = Effect.gen(function* () {
    const reported = Option.isSome(desktop) ? yield* desktop.value.cuaReadiness : Option.none();
    if (Option.isSome(reported) || Option.isNone(linuxHelper)) return reported;
    return yield* linuxHelper.value.liveReadiness;
  });
  const fromHost: Effect.Effect<ComputerUseDetection> = readinessReport.pipe(
    Effect.map(
      Option.match({
        onNone: () => ({ humanInput: false, privateMode: false, frames: false }),
        onSome: ({ signals, frames }) => ({
          humanInput: signals.humanInput === "supported",
          privateMode: honoredSignals(signals).privateMode === "supported",
          frames: frames === true,
        }),
      }),
    ),
  );
  const detection: Effect.Effect<ComputerUseDetection> = Option.isSome(linuxFrames)
    ? Effect.zipWith(fromHost, linuxFrames.value.supported, (reported, linux) => ({
        ...reported,
        frames: reported.frames || linux,
      }))
    : fromHost;
  const safetyReports = [
    ...(Option.isSome(desktop) ? [desktop.value.cuaSafety] : []),
    ...(Option.isSome(linuxHelper) ? [linuxHelper.value.safety] : []),
  ];
  if (safetyReports.length > 0)
    yield* Stream.mergeAll(safetyReports, { concurrency: "unbounded" }).pipe(
      Stream.runForEach((report) => (report.type === "cuaHumanInput" ? Effect.void : changed)),
      Effect.forkScoped,
    );
  return { desktop, linuxHelper, detection };
});
