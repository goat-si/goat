import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect("marks the shared SSH home before stopping and through failed-install recovery", () => {
  let markerSeen = false;
  const recoveryStarted = Deferred.makeUnsafe<void>();
  const releaseRecovery = Deferred.makeUnsafe<void>();
  const home = `/tmp/goat-desktop-updates-home-${process.pid}/.goat`;
  const marker = `${home}/runtime/desktop-update-in-progress`;
  const tunnelMarker = `${home}/runtime/${DESKTOP_UPDATE_RESTART_MARKER_FILE}`;
  const harness = makeHarness({
    env: { GOAT_HOME: home },
    stopBackend: Effect.sync(() => {
      markerSeen = harness.updateRestartMarkers.has(marker);
    }),
    startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseRecovery)),
    ),
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
      const install = yield* updates.install.pipe(Effect.forkChild);
      yield* Deferred.await(recoveryStarted);
      assert.isTrue(markerSeen);
      assert.isFalse(harness.updateRestartMarkers.has(tunnelMarker));
      assert.isTrue(harness.updateRestartMarkers.has(marker));
      yield* Deferred.succeed(releaseRecovery, undefined);
      assert.isTrue((yield* Fiber.join(install)).accepted);
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
});
