import { assert, describe, it } from "@effect/vitest";
import { DesktopUpdateStateSchema, type DesktopUpdateState } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { HttpClient, HttpClientResponse } from "effect/http";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendStartConfig,
  DesktopBackendSnapshot,
} from "../backend/DesktopBackendManager.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";
import { makeHarness } from "./updatesTestHarness.ts";

const decodeState = Schema.decodeSync(DesktopUpdateStateSchema);
const version = "1.2.4";
const pending = { version, channel: "latest" as const, downloadedAt: "2026-10-12T00:00:00.000Z" };
const observe = (
  updates: DesktopUpdates.DesktopUpdates["Service"],
  predicate: (state: DesktopUpdateState) => boolean,
) =>
  Effect.gen(function* () {
    const { latest, changes } = yield* updates.subscribe;
    if (predicate(latest)) return latest;
    return Option.getOrThrow(yield* Stream.runHead(changes.pipe(Stream.filter(predicate))));
  });

describe("DesktopUpdates automatic coordinator", () => {
  it("initial state validates without installing a durable record", () => {
    const state = createInitialDesktopUpdateState(
      "1.2.3",
      { hostArch: "x64", appArch: "x64", runningUnderArm64Translation: false },
      "latest",
    );
    assert.deepEqual(decodeState(state), state);
    assert.equal(state.installPolicy, "restart-when-idle");
    assert.isNull(state.downloadedVersion);
  });

  it.effect.each(["before-release", "after-release"])(
    "downloads once when availability arrives %s",
    (order) =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const downloading = yield* Deferred.make<void>();
        const harness = makeHarness({
          installPolicy: "install-on-quit",
          checkForUpdates: Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
          downloadUpdate: Deferred.succeed(downloading, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const check = yield* updates.check("manual").pipe(Effect.forkChild);
            yield* Deferred.await(checking);
            if (order === "before-release") {
              const available = yield* observe(
                updates,
                (state) => state.status === "available",
              ).pipe(Effect.forkChild);
              harness.emit("update-available", { version });
              yield* Fiber.join(available);
              assert.equal(harness.downloadCount(), 0);
            }
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(check);
            if (order === "after-release") harness.emit("update-available", { version });
            yield* Deferred.await(downloading);
            assert.equal(harness.downloadCount(), 1);
            assert.isFalse(harness.autoDownload());
            assert.isFalse(harness.autoInstallOnAppQuit());
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("pauses automatic downloads and resumes accepted availability immediately", () =>
    Effect.gen(function* () {
      const downloaded = yield* Deferred.make<void>();
      const harness = makeHarness({
        downloadUpdate: Deferred.succeed(downloaded, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const available = yield* observe(updates, (state) => state.status === "available").pipe(
            Effect.forkChild,
          );
          harness.emit("update-available", { version });
          yield* Fiber.join(available);
          assert.equal(harness.downloadCount(), 0);
          yield* updates.setInstallPolicy("install-on-quit");
          yield* Deferred.await(downloaded);
          assert.equal(harness.settings().updateInstallPolicy, "install-on-quit");
          assert.equal(harness.downloadCount(), 1);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("failed automatic download waits for another check generation", () =>
    Effect.gen(function* () {
      const failure = new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
        channel: "latest",
        cause: new Error("offline"),
      });
      const harness = makeHarness({
        installPolicy: "install-on-quit",
        downloadUpdate: Effect.fail(failure),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const failed = yield* observe(updates, (state) => state.errorContext === "download").pipe(
            Effect.forkChild,
          );
          harness.emit("update-available", { version });
          yield* Fiber.join(failed);
          yield* TestClock.adjust("60 seconds");
          assert.equal(harness.downloadCount(), 1);
          yield* updates.check("retry");
          const again = yield* observe(updates, (state) => state.errorContext === "download").pipe(
            Effect.forkChild,
          );
          harness.emit("update-available", { version });
          yield* Fiber.join(again);
          assert.equal(harness.downloadCount(), 2);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect(
    "regression: a nightly install whose update check stalls reports it and is offered the newer nightly at the next poll",
    () =>
      Effect.gen(function* () {
        const polled = yield* Deferred.make<void>();
        const downloading = yield* Deferred.make<void>();
        let checks = 0;
        const harness = makeHarness({
          appVersion: "0.1.2-nightly.20261022.236",
          initialSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            updateChannel: "nightly",
          },
          // The startup check's request never settles, as a stalled feed request does.
          checkForUpdates: Effect.suspend(() => {
            checks += 1;
            return checks === 1 ? Effect.never : Deferred.succeed(polled, undefined);
          }),
          downloadUpdate: Deferred.succeed(downloading, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;

            const stalled = yield* observe(updates, (state) => state.errorContext === "check").pipe(
              Effect.forkChild,
            );
            yield* TestClock.adjust("15 seconds");
            yield* TestClock.adjust("2 minutes");
            const failed = yield* Fiber.join(stalled);
            assert.equal(failed.status, "error");
            assert.equal(
              failed.message,
              "Could not check for updates: the update server did not answer within 2 minutes.",
            );

            yield* TestClock.adjust("2 minutes");
            yield* Deferred.await(polled);
            const offered = yield* observe(
              updates,
              (state) => state.availableVersion === "0.1.2-nightly.20261023.246",
            ).pipe(Effect.forkChild);
            harness.emit("update-available", { version: "0.1.2-nightly.20261023.246" });
            const state = yield* Fiber.join(offered);
            assert.equal(state.channel, "nightly");
            yield* Deferred.await(downloading);
            assert.equal(harness.checkCount(), 2);
            assert.equal(harness.downloadCount(), 1);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect(
    "a poll that finds a newer build than the downloaded one downloads it and keeps it ready to restart",
    () =>
      Effect.gen(function* () {
        const downloads = yield* Queue.unbounded<void>();
        const harness = makeHarness({
          installPolicy: "install-on-quit",
          downloadUpdate: Queue.offer(downloads, undefined).pipe(Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            harness.emit("update-available", { version: "1.2.4" });
            yield* Queue.take(downloads);
            const first = yield* observe(
              updates,
              (state) => state.downloadedVersion === "1.2.4",
            ).pipe(Effect.forkChild);
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* Fiber.join(first);

            assert.isTrue((yield* updates.check("poll")).checked);
            harness.emit("update-available", { version: "1.2.5" });
            yield* Queue.take(downloads);
            const second = yield* observe(
              updates,
              (state) => state.downloadedVersion === "1.2.5",
            ).pipe(Effect.forkChild);
            harness.emit("update-downloaded", { version: "1.2.5" });
            const state = yield* Fiber.join(second);
            assert.equal(state.status, "downloaded");
            assert.equal(state.pendingUpdate?.version, "1.2.5");
            assert.equal(harness.settings().pendingUpdate?.version, "1.2.5");
            assert.equal(harness.downloadCount(), 2);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("waits for the download reservation before stopping every backend and installing", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const downloading = yield* Deferred.make<void>();
      const installed = yield* Deferred.make<void>();
      const stopped: string[] = [];
      const harness = makeHarness({
        installPolicy: "restart-when-idle",
        downloadUpdate: Deferred.succeed(downloading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        stopBackend: Effect.sync(() => {
          stopped.push("primary");
        }),
        quitAndInstall: Effect.sync(() => {
          assert.deepEqual(stopped, ["primary"]);
        }).pipe(Effect.andThen(Deferred.succeed(installed, undefined)), Effect.asVoid),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version });
          yield* Deferred.await(downloading);
          const ready = yield* observe(
            updates,
            (state) => state.downloadedVersion === version,
          ).pipe(Effect.forkChild);
          harness.emit("update-downloaded", { version });
          yield* Fiber.join(ready);
          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(harness.settings().pendingUpdate?.version, version);
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(installed);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each([version, "1.2.5"])(
    "restores pending readiness across service instances from feed %s",
    (feedVersion) =>
      Effect.gen(function* () {
        const first = makeHarness();
        const settings = yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const ready = yield* observe(
              updates,
              (state) => state.downloadedVersion === version,
            ).pipe(Effect.forkChild);
            first.emit("update-downloaded", { version });
            yield* Fiber.join(ready);
            return first.settings();
          }),
        ).pipe(Effect.provide(first.layer));
        const restored = yield* Deferred.make<void>();
        const second = makeHarness({
          initialSettings: { ...settings, updateInstallPolicy: "install-on-quit" },
          checkForUpdates: Effect.sync(() => {
            second.emit("update-available", { version: feedVersion });
          }),
          downloadUpdate: Effect.sync(() => {
            second.emit("update-downloaded", { version: feedVersion });
          }).pipe(Effect.andThen(Deferred.succeed(restored, undefined)), Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const initial = yield* updates.getState;
            assert.isNull(initial.downloadedVersion);
            assert.equal(initial.recoveryStatus, "restoring");
            const ready = yield* observe(
              updates,
              (state) => state.downloadedVersion === feedVersion,
            ).pipe(Effect.forkChild);
            yield* updates.check("startup");
            yield* Deferred.await(restored);
            yield* Fiber.join(ready);
            assert.equal(second.settings().pendingUpdate?.version, feedVersion);
            assert.equal(second.downloadCount(), 1);
            assert.isNull((yield* updates.getState).recoveryStatus);
          }),
        ).pipe(Effect.provide(second.layer));
      }),
  );

  it.effect("preserves an in-session downgrade across checks and installs when idle", () =>
    Effect.gen(function* () {
      const downgrade = "1.2.2";
      const installed = yield* Deferred.make<void>();
      const harness = makeHarness({
        quitAndInstall: Deferred.succeed(installed, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.setChannel("nightly");
          yield* updates.setChannel("latest");
          const ready = yield* observe(
            updates,
            (state) => state.downloadedVersion === downgrade,
          ).pipe(Effect.forkChild);
          harness.emit("update-downloaded", { version: downgrade });
          yield* Fiber.join(ready);
          yield* updates.check("poll");
          assert.equal(harness.settings().pendingUpdate?.version, downgrade);
          assert.equal((yield* updates.getState).pendingUpdate?.version, downgrade);
          const checked = yield* observe(updates, (state) => state.status === "downloaded").pipe(
            Effect.forkChild,
          );
          harness.emit("update-not-available");
          yield* Fiber.join(checked);
          yield* updates.setInstallPolicy("restart-when-idle");
          yield* Deferred.await(installed);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect.each(["update-not-available", "ignored-channel"])(
    "clears unrestorable recovery when the feed reports %s",
    (event) => {
      const harness = makeHarness({
        initialSettings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, pendingUpdate: pending },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("startup");
          assert.equal((yield* updates.getState).recoveryStatus, "restoring");
          const checked = yield* observe(updates, (state) => state.status === "up-to-date").pipe(
            Effect.forkChild,
          );
          if (event === "ignored-channel")
            harness.emit("update-available", { version: "1.2.4-nightly.20261012.1" });
          else harness.emit("update-not-available");
          const state = yield* Fiber.join(checked);
          assert.isNull(state.recoveryStatus);
          assert.isNull(state.pendingRestartReason);
          assert.isNull(state.pendingUpdate);
          assert.isNull(harness.settings().pendingUpdate);
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("disabled updater retains intent without pretending to restore", () => {
    const harness = makeHarness({
      initialSettings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, pendingUpdate: pending },
      env: { GOAT_DISABLE_AUTO_UPDATE: "true" },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const state = yield* updates.getState;
        assert.equal(state.status, "disabled");
        assert.isNull(state.recoveryStatus);
        assert.deepEqual(state.pendingUpdate, pending);
        assert.equal(harness.listenerCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("download recovery failure exposes its error without network advice", () => {
    const harness = makeHarness({
      initialSettings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, pendingUpdate: pending },
      downloadUpdate: Effect.fail(
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
          channel: "latest",
          cause: new Error("checksum mismatch"),
        }),
      ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const failed = yield* observe(updates, (state) => state.errorContext === "download").pipe(
          Effect.forkChild,
        );
        harness.emit("update-available", { version });
        const state = yield* Fiber.join(failed);
        assert.isNull(state.recoveryStatus);
        assert.isNotNull(state.message);
        assert.deepEqual(state.pendingUpdate, pending);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("manual failure consumes the automatic attempt for that generation", () => {
    const harness = makeHarness({
      downloadUpdate: Effect.fail(
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
          channel: "latest",
          cause: new Error("disk full"),
        }),
      ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const available = yield* observe(updates, (state) => state.status === "available").pipe(
          Effect.forkChild,
        );
        harness.emit("update-available", { version });
        yield* Fiber.join(available);
        assert.isFalse((yield* updates.download).completed);
        yield* updates.setInstallPolicy("install-on-quit");
        yield* TestClock.adjust("60 seconds");
        assert.equal(harness.downloadCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offline metadata retains pending intent without enabling installation", () => {
    const harness = makeHarness({
      initialSettings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, pendingUpdate: pending },
      checkForUpdates: Effect.fail(
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
          channel: "latest",
          cause: new Error("offline"),
        }),
      ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("startup");
        const state = yield* updates.getState;
        assert.equal(state.recoveryStatus, "needs-network");
        assert.deepEqual(state.pendingUpdate, pending);
        assert.isNull(state.downloadedVersion);
        assert.isFalse((yield* updates.install).accepted);
        assert.equal(harness.downloadCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("paused recovery retains the record until unpaused", () => {
    const harness = makeHarness({
      initialSettings: {
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        updateInstallPolicy: "paused",
        pendingUpdate: pending,
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isNull((yield* updates.getState).recoveryStatus);
        assert.isNull((yield* updates.getState).downloadedVersion);
        yield* updates.setInstallPolicy("install-on-quit");
        assert.equal(harness.checkCount(), 1);
        assert.equal((yield* updates.getState).recoveryStatus, "restoring");
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("persistence failure suppresses readiness and automatic installation", () => {
    const harness = makeHarness({
      installPolicy: "restart-when-idle",
      setPendingUpdateError: new DesktopAppSettings.DesktopSettingsWriteError({
        operation: "replace-settings-file",
        path: "/test/settings.json",
        cause: new Error("disk full"),
      }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const failed = yield* observe(updates, (state) => state.errorContext === "download").pipe(
          Effect.forkChild,
        );
        harness.emit("update-downloaded", { version });
        yield* Fiber.join(failed);
        assert.isNull((yield* updates.getState).downloadedVersion);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isFalse((yield* updates.install).accepted);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { ...pending, version: "1.2.2" },
    { ...pending, channel: "nightly" as const },
  ])("clears superseded or mismatched records %j", (pendingUpdate) => {
    const harness = makeHarness({
      initialSettings: { ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, pendingUpdate },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isNull((yield* updates.getState).pendingUpdate);
        assert.isNull(harness.settings().pendingUpdate);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("a late download callback cannot restore the previous channel's readiness", () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetPendingUpdate: Deferred.succeed(saving, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Deferred.succeed(resumed, undefined)),
          Effect.asVoid,
        ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version });
          yield* Deferred.await(saving);
          yield* updates.setChannel("nightly");
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(resumed);
          yield* Effect.yieldNow;
          assert.equal((yield* updates.getState).channel, "nightly");
          assert.isNull((yield* updates.getState).downloadedVersion);
          assert.isNull((yield* updates.getState).pendingUpdate);
          assert.isNull(harness.settings().pendingUpdate);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("channel reservation blocks download and restores downgrade before release", () =>
    Effect.gen(function* () {
      const checking = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const downloading = yield* Deferred.make<void>();
      const harness = makeHarness({
        installPolicy: "install-on-quit",
        checkForUpdates: Deferred.succeed(checking, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        downloadUpdate: Effect.sync(() => {
          assert.isFalse(harness.allowDowngrade());
        }).pipe(Effect.andThen(Deferred.succeed(downloading, undefined)), Effect.asVoid),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const channel = yield* updates.setChannel("nightly").pipe(Effect.forkChild);
          yield* Deferred.await(checking);
          assert.isTrue(harness.allowDowngrade());
          const available = yield* observe(updates, (state) => state.status === "available").pipe(
            Effect.forkChild,
          );
          harness.emit("update-available", { version: "1.2.4-nightly.20261012.1" });
          yield* Fiber.join(available);
          assert.equal(harness.downloadCount(), 0);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(channel);
          yield* Deferred.await(downloading);
          assert.isFalse(harness.allowDowngrade());
          assert.equal(harness.downloadCount(), 1);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("DesktopUpdates idle convergence", () => {
  it.effect("re-probes activity at admission and refuses a backend that became busy", () => {
    let requests = 0;
    const config = {
      httpBaseUrl: new URL("http://127.0.0.1:4444"),
      executablePath: "node",
    } as DesktopBackendStartConfig;
    const primary: DesktopBackendPool.DesktopBackendInstance = {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("primary"),
      start: Effect.void,
      stop: () => Effect.die("busy backend must not stop"),
      currentConfig: Effect.succeedSome(config),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: true,
        activePid: Option.some(42),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.succeed(true),
    };
    const harness = makeHarness({
      installPolicy: "restart-when-idle",
      backendInstances: [primary],
      httpClient: HttpClient.make((request) =>
        Effect.sync(() => {
          requests += 1;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              activity: requests === 1 ? "idle" : "busy",
              pid: 42,
              serverVersion: "1.2.3",
            }),
          );
        }),
      ),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const postponed = yield* observe(
          updates,
          (state) => state.pendingRestartReason === "busy",
        ).pipe(Effect.forkChild);
        harness.emit("update-downloaded", { version });
        yield* Fiber.join(postponed);
        assert.equal(requests, 2);
        assert.equal(harness.quitAndInstalls(), 0);
        // A fresh busy probe is meaningful; publishing the identical reason again isn't.
        yield* TestClock.adjust("60 seconds");
        const afterFirstWake = harness.sentStates.length;
        yield* TestClock.adjust("60 seconds");
        assert.equal(harness.sentStates.length, afterFirstWake);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect.each(["busy", "unknown", "wsl"])(
    "postpones %s and installs after a 60-second idle probe",
    (initial) =>
      Effect.gen(function* () {
        let idle = false;
        const stopped: string[] = [];
        const installed = yield* Deferred.make<void>();
        let snapshot: DesktopBackendSnapshot = {
          ready: true,
          desiredRunning: true,
          activePid: Option.some(42),
          restartAttempt: 0,
          restartScheduled: false,
        };
        const config = {
          httpBaseUrl: new URL("http://192.168.1.9:4444"),
          executablePath: initial === "wsl" ? "wsl.exe" : "node",
          ...(initial === "wsl" ? { runningDistro: "Ubuntu" } : {}),
        } as DesktopBackendStartConfig;
        const primary: DesktopBackendPool.DesktopBackendInstance = {
          id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
          label: Effect.succeed("primary"),
          start: Effect.void,
          stop: () =>
            Effect.sync(() => {
              stopped.push("primary");
            }),
          currentConfig: Effect.succeedSome(config),
          snapshot: Effect.sync(() => snapshot),
          waitForReady: () => Effect.succeed(true),
        };
        const secondary: DesktopBackendPool.DesktopBackendInstance = {
          ...primary,
          id: DesktopBackendPool.BackendInstanceId("secondary"),
          currentConfig: Effect.succeedNone,
          snapshot: Effect.succeed({
            ...snapshot,
            desiredRunning: false,
            ready: false,
            activePid: Option.none(),
          }),
          stop: () =>
            Effect.sync(() => {
              stopped.push("secondary");
            }),
        };
        const harness = makeHarness({
          installPolicy: "restart-when-idle",
          backendInstances: [primary, secondary],
          httpClient: HttpClient.make((request) =>
            Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  activity: idle ? "idle" : "busy",
                  pid: initial === "unknown" && !idle ? 99 : 42,
                  serverVersion: "1.2.3",
                }),
              ),
            ),
          ),
          checkForUpdates: Effect.sync(() => {
            harness.emit("update-not-available");
          }),
          quitAndInstall: Effect.sync(() => {
            assert.deepEqual(stopped.toSorted(), ["primary", "secondary"]);
          }).pipe(Effect.andThen(Deferred.succeed(installed, undefined)), Effect.asVoid),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const postponed = yield* observe(
              updates,
              (state) => state.pendingRestartReason === (initial === "busy" ? "busy" : "unknown"),
            ).pipe(Effect.forkChild);
            harness.emit("update-downloaded", { version });
            yield* Fiber.join(postponed);
            assert.equal(harness.quitAndInstalls(), 0);
            if (initial === "wsl") {
              assert.include((yield* updates.getState).message ?? "", "WSL");
              snapshot = {
                ...snapshot,
                desiredRunning: false,
                ready: false,
                activePid: Option.none(),
              };
            }
            idle = true;
            yield* TestClock.adjust("60 seconds");
            yield* Deferred.await(installed);
            assert.equal(harness.quitAndInstalls(), 1);
            assert.equal(harness.settings().pendingUpdate?.version, version);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );
});
