import { DesktopHostTelemetryMessage } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopTelemetryPublisher from "./DesktopTelemetryPublisher.ts";
import * as DesktopRendererHistory from "./DesktopRendererHistory.ts";

const layerHistory = Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
  register: () => Effect.void,
  recordMetrics: () => Effect.void,
  shutdown: Effect.void,
});

function layerElectronApp(
  metrics: ReadonlyArray<Electron.ProcessMetric>,
  onMetricsRead: () => void = () => undefined,
) {
  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
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
    getAppMetrics: Effect.sync(() => {
      onMetricsRead();
      return metrics;
    }),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    removeCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerCuaRouting = DesktopTelemetryPublisher.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerElectronApp([]),
      layerHistory,
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

const collectTelemetry = Effect.fn(function* (stream: Stream.Stream<Uint8Array>) {
  const messages = yield* Queue.unbounded<DesktopHostTelemetryMessage>();
  const received: DesktopHostTelemetryMessage[] = [];
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopHostTelemetryMessage));
  const fiber = yield* stream.pipe(
    Stream.mapEffect((bytes) => decode(new TextDecoder().decode(bytes).trim())),
    Stream.runForEach((message) => {
      received.push(message);
      return Queue.offer(messages, message);
    }),
    Effect.forkScoped,
  );
  const next = Effect.fn(function* (type: DesktopHostTelemetryMessage["type"]) {
    let message = yield* Queue.take(messages);
    while (message.type !== type) message = yield* Queue.take(messages);
    return message;
  });
  yield* next("desktopTelemetryHello");
  yield* next("desktopTelemetry");
  return { fiber, received, next };
});

it.effect("routes browser manifest requests and replies only to their primary source", () =>
  Effect.gen(function* () {
    const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
    const primary = yield* collectTelemetry(publisher.encodedForSource("primary"));
    const requests = publisher.cuaManifestRequests;
    if (!requests) return assert.fail("manifest channel absent");
    yield* publisher.handleControlForSource("ssh:remote", {
      version: 1,
      type: "cuaManifestRequest",
      requestId: "foreign",
      union: { existingProfiles: [], origins: [] },
    });
    yield* publisher.handleControlForSource("primary", {
      version: 1,
      type: "cuaManifestRequest",
      requestId: "accepted",
      union: { existingProfiles: [{ pid: 12, windowId: 34 }], origins: [] },
    });
    const next = yield* Stream.runHead(requests);
    if (Option.isNone(next)) return assert.fail("request absent");
    assert.equal(next.value.request.requestId, "accepted");
    const report = {
      version: 1,
      type: "cuaManifestReport",
      requestId: "accepted",
      status: "written",
      sha256: "a".repeat(64),
    } as const;
    yield* next.value.reply(report);
    assert.deepEqual(yield* primary.next("cuaManifestReport"), report);
    assert.isTrue(next.value.isCurrent());
    yield* publisher.removeControlSource("primary");
    assert.isFalse(next.value.isCurrent());
  }).pipe(Effect.provide(layerCuaRouting), Effect.scoped),
);
