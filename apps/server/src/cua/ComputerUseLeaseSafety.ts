import type {
  DesktopCuaPersonStopReport,
  DesktopCuaReadinessReport,
  DesktopCuaSafetyReport,
  DesktopCuaSessionLockReport,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import type { ComputerUseDetection } from "./ComputerUseLeases.ts";
import { honoredSignals } from "./ComputerUsePrivateMode.ts";
import * as LinuxFrameSource from "./linuxFrames/LinuxFrameSource.ts";
import * as LinuxHelperHost from "./linuxHelperHost/LinuxHelperHost.ts";

export interface LeaseSafetyHandlers {
  readonly changed: Effect.Effect<void>;
  readonly onPersonStop: (report: DesktopCuaPersonStopReport) => Effect.Effect<void>;
  readonly onSessionLock: (report: DesktopCuaSessionLockReport) => Effect.Effect<void>;
}

interface SafetySource {
  readonly readiness: Effect.Effect<Option.Option<DesktopCuaReadinessReport>>;
  readonly safety: Stream.Stream<DesktopCuaSafetyReport>;
}

export const makeLeaseSafety = Effect.fn("ComputerUseLeaseSafety.make")(function* (
  handlers: LeaseSafetyHandlers,
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
  const safetySources: ReadonlyArray<SafetySource> = [
    ...(Option.isSome(desktop)
      ? [{ readiness: desktop.value.cuaReadiness, safety: desktop.value.cuaSafety }]
      : []),
    ...(Option.isSome(linuxHelper)
      ? [{ readiness: linuxHelper.value.liveReadiness, safety: linuxHelper.value.safety }]
      : []),
  ];
  for (const source of safetySources) {
    let observedGeneration: number | undefined;
    const acceptGeneration = (generation: number | undefined) =>
      Effect.map(source.readiness, (current) => {
        const readinessGeneration = Option.isSome(current) ? current.value.generation : undefined;
        const latestGeneration =
          readinessGeneration === undefined
            ? observedGeneration
            : observedGeneration === undefined
              ? readinessGeneration
              : Math.max(readinessGeneration, observedGeneration);
        if (generation === undefined) return true;
        if (latestGeneration !== undefined && generation < latestGeneration) return false;
        observedGeneration =
          latestGeneration === undefined ? generation : Math.max(latestGeneration, generation);
        return true;
      });
    yield* source.safety.pipe(
      Stream.runForEach((report) =>
        Effect.gen(function* () {
          if (report.type === "cuaHumanInput") return;
          if (report.type === "cuaReadiness") {
            if (!(yield* acceptGeneration(report.generation))) return;
            yield* handlers.changed;
            return;
          }
          if (report.type === "cuaPersonStop") {
            if (!(yield* acceptGeneration(report.generation))) return;
            yield* handlers.onPersonStop(report);
            return;
          }
          if (report.type === "cuaSessionLock") {
            if (!(yield* acceptGeneration(report.generation))) return;
            yield* handlers.onSessionLock(report);
            return;
          }
          yield* handlers.changed;
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }
  return { desktop, linuxHelper, detection };
});
