import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopRendererHistory from "./DesktopRendererHistory.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";
import { collectTelemetry } from "./DesktopTelemetryPublisher.testkit.ts";

const layerCuaSafety = DesktopTelemetryPublisher.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("GOAT"),
        systemLocale: Effect.succeed("en-US"),
        whenReady: Effect.void,
        requestSingleInstanceLock: Effect.succeed(true),
        quit: Effect.void,
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        removeCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: () => Effect.void,
        on: () => Effect.void,
      } satisfies ElectronApp.ElectronApp["Service"]),
      Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
        register: () => Effect.void,
        recordMetrics: () => Effect.void,
        shutdown: Effect.void,
      }),
      Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
        installIntoProcess: Effect.succeed(true),
        awaitDiscovery: Effect.succeed(true),
        discoverySettled: Effect.succeed(true),
        updates: Stream.empty,
      }),
      Layer.succeed(
        ElectronPowerMonitor.ElectronPowerMonitor,
        ElectronPowerMonitor.ElectronPowerMonitor.of({
          isOnBatteryPower: Effect.succeed(false),
          getSystemIdleTime: Effect.succeed(0),
          getSystemIdleState: () => Effect.succeed("active"),
          getCurrentThermalState: Effect.succeed("nominal"),
          onSimpleEvent: () => Effect.void,
          onThermalStateChange: () => Effect.void,
          onSpeedLimitChange: () => Effect.void,
        }),
      ),
    ),
  ),
);

describe("DesktopTelemetryPublisher CUA safety routing", () => {
  it.effect(
    "publishes cuaPersonStop and cuaSessionLock to primary only and replays active session lock on reconnect",
    () =>
      Effect.gen(function* () {
        const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
        const locked = {
          version: 1,
          type: "cuaSessionLock",
          generation: 2,
          locked: true,
          reasons: ["screen_locked"],
        } as const;
        const unlocked = {
          version: 1,
          type: "cuaSessionLock",
          generation: 2,
          locked: false,
          reasons: [],
        } as const;
        const personStop = {
          version: 1,
          type: "cuaPersonStop",
          generation: 2,
          reason: "person_esc",
        } as const;

        yield* publisher.publishCuaSafety(locked);
        yield* publisher.publishCuaSafety(personStop);
        yield* publisher.publishCuaReadiness({
          version: 1,
          type: "cuaReadiness",
          generation: 5,
          readiness: {
            grants: { accessibility: "granted", screenCapture: "granted" },
            helper: "authenticated",
            capture: "ready",
            tree: "ready",
            input: "background",
            blockers: [],
            reasons: [],
          },
          signals: { privateMode: "supported", humanInput: "supported" },
        });
        const reconnected = yield* collectTelemetry(publisher.encodedForSource("primary"));
        const remote = yield* collectTelemetry(publisher.encodedForSource("ssh:remote"));
        const replayed =
          reconnected.received.find((message) => message.type === "cuaSessionLock") ??
          (yield* reconnected.next("cuaSessionLock"));
        assert.deepEqual(replayed, { ...locked, generation: 5 });
        assert.isEmpty(reconnected.received.filter((message) => message.type === "cuaPersonStop"));

        yield* publisher.publishCuaSafety(personStop);
        assert.deepEqual(yield* reconnected.next("cuaPersonStop"), personStop);
        yield* publisher.publishCuaSafety(unlocked);
        assert.deepEqual(yield* reconnected.next("cuaSessionLock"), unlocked);
        yield* Fiber.interrupt(reconnected.fiber);

        const later = yield* collectTelemetry(publisher.encodedForSource("primary"));
        yield* publisher.handleControlForSource("primary", {
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });
        yield* later.next("desktopTelemetry");
        yield* remote.next("desktopTelemetry");
        assert.isEmpty(later.received.filter((message) => message.type === "cuaSessionLock"));
        assert.isEmpty(later.received.filter((message) => message.type === "cuaPersonStop"));
        assert.isEmpty(remote.received.filter((message) => message.type === "cuaSessionLock"));
        assert.isEmpty(remote.received.filter((message) => message.type === "cuaPersonStop"));
      }).pipe(Effect.provide(layerCuaSafety), Effect.scoped),
  );
});
