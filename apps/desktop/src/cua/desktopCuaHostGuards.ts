import type { DesktopCuaSessionLockReport } from "@goat/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { makeSessionLockGuard } from "../computerUse/sessionLockGuard.ts";
import type * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import type { Engine, PowerSaveBlockerLike } from "./DesktopCuaNative.ts";
import type { OwnedHost } from "./DesktopCuaOwnedHost.ts";
import { PROOF_RESET_DETAIL, proofLostDetail, resetProofOn } from "./readinessProof.ts";

export type DesktopCuaPowerEvent =
  | "lock-screen"
  | "unlock-screen"
  | "suspend"
  | "resume"
  | "user-did-resign-active"
  | "user-did-become-active";

export interface DesktopCuaPowerSource {
  readonly on: (
    event: DesktopCuaPowerEvent,
    listener: () => void,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly getSystemIdleState?: (idleThresholdSeconds: number) => Effect.Effect<string>;
  readonly handled?: () => void;
}

const defaultPowerSaveBlocker = (): PowerSaveBlockerLike | undefined => {
  const blocker = (Electron as { readonly powerSaveBlocker?: PowerSaveBlockerLike } | undefined)
    ?.powerSaveBlocker;
  return typeof blocker?.start === "function" && typeof blocker.stop === "function"
    ? blocker
    : undefined;
};

export const excludedHostBundleIds = (
  environment: {
    readonly appUserModelId: string;
    readonly isPackaged: boolean;
    readonly platform: NodeJS.Platform;
  },
  engine: Engine,
  executablePath: string,
) => [
  environment.appUserModelId,
  ...(environment.isPackaged ? [] : ["com.github.Electron"]),
  ...(environment.platform === "win32" ? [executablePath] : []),
  ...(engine.kind === "helper" ? [engine.bundle.bundleId] : []),
];

export const makeDesktopCuaHostGuards = Effect.fn("desktop.cua.hostGuards.make")(function* (deps: {
  readonly publisher: DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"];
  readonly power?: DesktopCuaPowerSource | undefined;
  readonly platform: NodeJS.Platform;
  readonly powerSaveBlocker?: PowerSaveBlockerLike | undefined;
  readonly mutex: Semaphore.Semaphore;
  readonly isClosed: () => boolean;
  readonly generation: () => number;
  readonly onProofReset: (detail: string) => Effect.Effect<void>;
}) {
  const sessionLockReports = yield* Queue.unbounded<DesktopCuaSessionLockReport>();
  let lastSessionLockKey = "false:";
  let powerSaveBlockerId: number | undefined;
  let powerSaveBlockerActive = false;

  const resolvePowerSaveBlocker = () => deps.powerSaveBlocker ?? defaultPowerSaveBlocker();

  const releasePowerSaveBlocker = () => {
    powerSaveBlockerActive = false;
    const id = powerSaveBlockerId;
    if (id === undefined) return;
    powerSaveBlockerId = undefined;
    const blocker = resolvePowerSaveBlocker();
    if (!blocker) return;
    try {
      if (blocker.isStarted === undefined || blocker.isStarted(id)) blocker.stop(id);
    } catch {
      return;
    }
  };

  const syncPowerSaveBlocker = (active: boolean) => {
    if (deps.isClosed() || !active) {
      releasePowerSaveBlocker();
      return;
    }
    if (powerSaveBlockerActive && powerSaveBlockerId !== undefined) return;
    const blocker = resolvePowerSaveBlocker();
    if (!blocker) return;
    try {
      powerSaveBlockerId = blocker.start("prevent-display-sleep");
      powerSaveBlockerActive = true;
    } catch {
      powerSaveBlockerId = undefined;
      powerSaveBlockerActive = false;
    }
  };

  const sessionLockGuard = makeSessionLockGuard({
    onChange: (snapshot) => {
      if (deps.isClosed()) return;
      const key = `${snapshot.locked}:${snapshot.reasons.join(",")}`;
      if (snapshot.transition !== "paused" && key === lastSessionLockKey) return;
      lastSessionLockKey = key;
      Queue.offerUnsafe(sessionLockReports, {
        version: 1,
        type: "cuaSessionLock",
        generation: deps.generation(),
        locked: snapshot.locked,
        reasons: [...snapshot.reasons],
      });
    },
  });

  yield* Effect.addFinalizer(() => Effect.sync(releasePowerSaveBlocker));

  const listen = Effect.fn("desktop.cua.hostGuards.listen")(function* (runtime: {
    readonly getOwned: () => OwnedHost | undefined;
    readonly restartHost: Effect.Effect<void>;
  }) {
    yield* deps.publisher.cuaWatchApps.pipe(
      Stream.runForEach((apps) =>
        deps.mutex.withPermits(1)(
          Effect.gen(function* () {
            const entry = runtime.getOwned();
            if (deps.isClosed() || !entry || entry.cleanup) return;
            if ((yield* entry.refreshManifest(apps)) && !entry.direct) yield* runtime.restartHost;
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not refresh Cua Driver manifest", { cause }),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Effect.sync(releasePowerSaveBlocker));
    yield* Stream.runForEach(
      Stream.fromQueue(sessionLockReports),
      deps.publisher.publishCuaSafety,
    ).pipe(Effect.forkScoped);
    if (deps.power !== undefined) {
      const power = deps.power;
      const registrations: Array<readonly [DesktopCuaPowerEvent, () => void]> = [];
      const detachGuard = sessionLockGuard.attachPowerMonitor({
        on: (event, listener) => {
          registrations.push([event as DesktopCuaPowerEvent, listener]);
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(detachGuard));
      yield* Effect.forEach(registrations, ([event, listener]) => power.on(event, listener), {
        discard: true,
      });
      if (power.getSystemIdleState !== undefined) {
        const idleState = yield* power
          .getSystemIdleState(1)
          .pipe(Effect.orElseSucceed(() => "active"));
        if (idleState === "locked") {
          sessionLockGuard.reportPoll({ screenLocked: true });
        }
      }
    }
    if (deps.power !== undefined && deps.platform === "darwin") {
      yield* resetProofOn(deps.power, (event) =>
        deps.mutex.withPermits(1)(
          deps.onProofReset(proofLostDetail(PROOF_RESET_DETAIL[event], "darwin")),
        ),
      );
    }
  });

  return {
    onWatch: (active: boolean) => {
      sessionLockGuard.setWatching(active);
      syncPowerSaveBlocker(active);
    },
    release: releasePowerSaveBlocker,
    listen,
  };
});
