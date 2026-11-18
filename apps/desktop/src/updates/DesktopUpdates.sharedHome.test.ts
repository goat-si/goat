import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect("marks the shared SSH home before stopping the desktop backend", () => {
  let markerSeen = false;
  const home = `/tmp/goat-desktop-updates-home-${process.pid}/.goat`;
  const marker = `${home}/runtime/desktop-update-in-progress`;
  const harness = makeHarness({
    env: { GOAT_HOME: home },
    stopBackend: Effect.sync(() => {
      markerSeen = harness.updateRestartMarkers.has(marker);
    }),
    quitAndInstall: Effect.fail(
      new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
        channel: "latest",
        isSilent: true,
        isForceRunAfter: true,
        cause: new Error("installer refused"),
      }),
    ),
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-downloaded", { version: "1.2.4" });
      yield* flushCallbacks;
      assert.isTrue((yield* updates.install).accepted);
      assert.isTrue(markerSeen);
      assert.isFalse(harness.updateRestartMarkers.has(marker));
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});
