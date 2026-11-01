import type { DesktopSystemWakeEvent } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { SYSTEM_WAKE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSystemWake from "./DesktopSystemWake.ts";

describe("DesktopSystemWake", () => {
  it.effect(
    "forwards suspend and measured sleep duration, and ignores duplicate macOS resume events without replacing a short-sleep session",
    () =>
      Effect.gen(function* () {
        const powerListeners = new Map<string, () => void>();
        const sentEvents: Array<{ readonly channel: string; readonly payload: unknown }> = [];
        let tunnelRevalidations = 0;

        const layer = DesktopSystemWake.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronApp.ElectronApp, {
                metadata: Effect.die("unused"),
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
              }),
              Layer.succeed(ElectronPowerMonitor.ElectronPowerMonitor, {
                isOnBatteryPower: Effect.succeed(false),
                getSystemIdleTime: Effect.succeed(0),
                getSystemIdleState: () => Effect.succeed("active" as const),
                getCurrentThermalState: Effect.succeed("nominal" as const),
                onSimpleEvent: (eventName, listener) =>
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      powerListeners.set(eventName, listener);
                    }),
                    () =>
                      Effect.sync(() => {
                        powerListeners.delete(eventName);
                      }),
                  ).pipe(Effect.asVoid),
                onThermalStateChange: () => Effect.void,
                onSpeedLimitChange: () => Effect.void,
              }),
              Layer.succeed(ElectronWindow.ElectronWindow, {
                create: () => Effect.die("unused"),
                main: Effect.die("unused"),
                currentMainOrFirst: Effect.die("unused"),
                focusedMainOrFirst: Effect.die("unused"),
                setMain: () => Effect.void,
                clearMain: () => Effect.void,
                prepareReveal: () => Effect.succeed(false),
                reveal: () => Effect.void,
                sendAll: (channel, payload) =>
                  Effect.sync(() => {
                    sentEvents.push({ channel, payload });
                  }),
                destroyAll: Effect.void,
                syncAllAppearance: () => Effect.void,
              }),
              Layer.succeed(DesktopSshEnvironment.DesktopSshEnvironment, {
                discoverHosts: () => Effect.die("unused"),
                resolveHost: () => Effect.die("unused"),
                ensureEnvironment: () => Effect.die("unused"),
                status: () => Effect.die("unused"),
                update: () => Effect.die("unused"),
                disconnectEnvironment: () => Effect.die("unused"),
                revalidateTunnels: Effect.sync(() => {
                  tunnelRevalidations += 1;
                }),
              }),
            ),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.adjust(0);

            powerListeners.get("suspend")?.();
            yield* TestClock.adjust(0);
            assert.deepEqual(sentEvents, [
              {
                channel: SYSTEM_WAKE_CHANNEL,
                payload: { reason: "suspend", asleepMs: null } satisfies DesktopSystemWakeEvent,
              },
            ]);
            assert.equal(tunnelRevalidations, 0);
            yield* TestClock.adjust("2 seconds");

            // First resume reports the 2s sleep; duplicate resume 100ms later is ignored.
            powerListeners.get("resume")?.();
            yield* TestClock.adjust(0);
            yield* TestClock.adjust("100 millis");
            powerListeners.get("resume")?.();
            yield* TestClock.adjust(0);

            assert.deepEqual(sentEvents, [
              {
                channel: SYSTEM_WAKE_CHANNEL,
                payload: { reason: "suspend", asleepMs: null } satisfies DesktopSystemWakeEvent,
              },
              {
                channel: SYSTEM_WAKE_CHANNEL,
                payload: { reason: "resume", asleepMs: 2_000 } satisfies DesktopSystemWakeEvent,
              },
            ]);
            assert.equal(tunnelRevalidations, 1);

            // A new paired sleep is real even inside the duplicate window.
            powerListeners.get("suspend")?.();
            yield* TestClock.adjust(0);
            yield* TestClock.adjust("100 millis");
            powerListeners.get("resume")?.();
            yield* TestClock.adjust(0);
            assert.equal(sentEvents.length, 4);
            assert.equal(tunnelRevalidations, 2);
            assert.deepEqual(sentEvents[3]?.payload, { reason: "resume", asleepMs: 100 });

            yield* TestClock.adjust("3 seconds");
            powerListeners.get("resume")?.();
            yield* TestClock.adjust(0);
            assert.equal(sentEvents.length, 5);
            assert.equal(tunnelRevalidations, 3);
            assert.deepEqual(sentEvents[4]?.payload, { reason: "resume", asleepMs: null });

            powerListeners.get("suspend")?.();
            yield* TestClock.adjust(0);
            yield* TestClock.adjust("2 minutes");
            assert.equal(tunnelRevalidations, 3);
            powerListeners.get("resume")?.();
            yield* TestClock.adjust(0);
            assert.deepEqual(
              sentEvents.slice(-2).map((event) => event.payload),
              [
                { reason: "suspend", asleepMs: null },
                { reason: "resume", asleepMs: 120_000 },
              ],
            );
            assert.equal(tunnelRevalidations, 4);
          }),
        ).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(TestClock.layer())),
  );
});
