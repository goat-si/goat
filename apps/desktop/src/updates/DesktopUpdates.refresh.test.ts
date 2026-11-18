import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

it.effect("keeps a same-version offer visible and queues a download behind the refresh", () =>
  Effect.gen(function* () {
    const checkStarted = yield* Deferred.make<void>();
    const finishCheck = yield* Deferred.make<void>();
    const harness = makeHarness({
      checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishCheck)),
        Effect.andThen(Effect.sync(() => harness.emit("update-available", { version: "1.2.4" }))),
      ),
    });
    yield* Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-available", { version: "1.2.4", releaseNotes: "fix: queued update" });
      yield* flushCallbacks;
      const before = yield* updates.getState;
      const check = yield* updates.check("poll").pipe(Effect.forkScoped);
      yield* Deferred.await(checkStarted);
      assert.deepEqual(yield* updates.getState, before);
      const download = yield* updates.download.pipe(Effect.forkScoped);
      yield* flushCallbacks;
      assert.isUndefined(download.pollUnsafe());
      yield* Deferred.succeed(finishCheck, undefined);
      assert.isTrue((yield* Fiber.join(check)).checked);
      assert.isTrue((yield* Fiber.join(download)).accepted);
      assert.equal(harness.downloadCount(), 1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect.each(["new offer", "no offer", "failed check"] as const)(
  "refreshes the selected feed before downloading: %s",
  (result) => {
    let candidate = "1.2.4";
    let downloaded: string | null = null;
    const harness = makeHarness({
      checkForUpdates: Effect.suspend(() => {
        if (result === "failed check")
          return Effect.fail(
            new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
              channel: "latest",
              cause: new Error("offline"),
            }),
          );
        if (result === "no offer") harness.emit("update-not-available");
        else {
          candidate = "1.2.5";
          harness.emit("update-available", { version: candidate });
        }
        return Effect.void;
      }),
      downloadUpdate: Effect.sync(() => {
        downloaded = candidate;
      }),
    });
    return Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      harness.emit("update-available", { version: "1.2.4" });
      yield* flushCallbacks;
      const download = yield* updates.download;
      assert.equal(download.completed, result !== "no offer");
      assert.equal(
        downloaded,
        result === "no offer" ? null : result === "failed check" ? "1.2.4" : "1.2.5",
      );
      assert.equal(harness.checkCount(), 1);
      assert.isFalse(harness.sentStates.some((state) => state.status === "error"));
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  },
);

it.effect(
  "keeps a prepared request exact while ordinary install considers the newer release",
  () => {
    const makeOfferHarness = () => {
      const harness = makeHarness({
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.5" })),
        downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.5" })),
      });
      return harness;
    };
    return Effect.gen(function* () {
      for (const prepared of [true, false]) {
        const harness = makeOfferHarness();
        yield* Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          const install = yield* prepared ? updates.installPrepared("1.2.4") : updates.install;
          assert.isTrue(install.accepted);
          assert.equal(harness.quitAndInstalls(), 1);
          assert.equal(harness.checkCount(), prepared ? 0 : 1);
          assert.equal(harness.settings().pendingUpdate?.version, prepared ? "1.2.4" : "1.2.5");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }
    });
  },
);

it.effect("a failed newer download stops before restarting the retained build", () => {
  const harness = makeHarness({
    checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.5" })),
    downloadUpdate: Effect.fail(
      new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
        channel: "latest",
        cause: new Error("disk full"),
      }),
    ),
  });
  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    harness.emit("update-downloaded", { version: "1.2.4" });
    yield* flushCallbacks;
    const result = yield* updates.install;
    assert.equal(result.state.errorContext, "download");
    assert.equal(harness.settings().pendingUpdate?.version, "1.2.4");
    assert.equal(harness.quitAndInstalls(), 0);
    assert.equal(harness.installRecords.size, 0);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});

it.effect.each(["recorded", "missing"] as const)(
  "keeps the reservation until the matching download is persisted or the wait expires: %s",
  (persistence) =>
    Effect.gen(function* () {
      const downloaded = yield* Deferred.make<void>();
      const quitting = yield* Deferred.make<void>();
      const recording = yield* Deferred.make<void>();
      const releaseRecord = yield* Deferred.make<void>();
      let saves = 0;
      const harness = makeHarness({
        checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.5" })),
        beforeSetPendingUpdate: Effect.suspend(() =>
          ++saves === 1
            ? Effect.void
            : Deferred.succeed(recording, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRecord)),
              ),
        ),
        downloadUpdate: Effect.sync(() => {
          harness.emit("update-downloaded", { version: "1.2.4" });
          if (persistence === "recorded") harness.emit("update-downloaded", { version: "1.2.5" });
        }).pipe(Effect.andThen(Deferred.succeed(downloaded, undefined)), Effect.asVoid),
        quitAndInstall: Deferred.succeed(quitting, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        const install = yield* updates.install.pipe(Effect.forkScoped);
        yield* Effect.raceFirst(Deferred.await(downloaded), Deferred.await(quitting));
        assert.equal(harness.quitAndInstalls(), 0);
        assert.isTrue(yield* updates.isActionActive);
        if (persistence === "recorded") {
          yield* Deferred.await(recording);
          assert.equal(harness.settings().pendingUpdate?.version, "1.2.4");
          yield* Deferred.succeed(releaseRecord, undefined);
          assert.isTrue((yield* Fiber.join(install)).accepted);
          assert.equal(harness.settings().pendingUpdate?.version, "1.2.5");
          assert.equal(harness.quitAndInstalls(), 1);
        } else {
          yield* TestClock.adjust("2 minutes");
          const settled = install.pollUnsafe();
          assert.isDefined(settled);
          assert.equal((yield* Fiber.join(install)).state.errorContext, "download");
          assert.isFalse(yield* updates.isActionActive);
          assert.equal(harness.quitAndInstalls(), 0);
        }
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect.each(["paused", "busy"] as const)(
  "does not restart when refresh leaves it %s",
  (reason) =>
    Effect.gen(function* () {
      const quit = yield* Deferred.make<void>();
      const denied = yield* Deferred.make<void>();
      let refreshed = false;
      let pause = Effect.void;
      const harness = makeHarness({
        installPolicy: "restart-when-idle",
        checkForUpdates: Effect.suspend(() => {
          refreshed = true;
          return pause;
        }),
        httpClient: HttpClient.make((request) =>
          Effect.suspend(() => {
            const activity = refreshed && reason === "busy" ? "busy" : "idle";
            const signal = activity === "busy" ? Deferred.succeed(denied, undefined) : Effect.void;
            return signal.pipe(
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    activity,
                    pid: 42,
                    serverVersion: "1.2.3",
                  }),
                ),
              ),
            );
          }),
        ),
        quitAndInstall: Deferred.succeed(quit, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        if (reason === "paused")
          pause = updates
            .setInstallPolicy("paused")
            .pipe(Effect.orDie, Effect.andThen(Deferred.succeed(denied, undefined)), Effect.asVoid);
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* Effect.raceFirst(Deferred.await(denied), Deferred.await(quit));
        yield* TestClock.adjust("1 second");
        assert.isTrue(refreshed);
        assert.isFalse(yield* updates.isActionActive);
        assert.equal(harness.quitAndInstalls(), 0);
        assert.equal(harness.installRecords.size, 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("keeps the retained download when the selected feed offers an older release", () => {
  const harness = makeHarness({
    checkForUpdates: Effect.sync(() => harness.emit("update-available", { version: "1.2.4" })),
  });
  return Effect.gen(function* () {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    yield* updates.configure;
    harness.emit("update-downloaded", { version: "1.2.5" });
    yield* flushCallbacks;
    assert.isTrue((yield* updates.install).accepted);
    assert.equal(harness.checkCount(), 1);
    assert.equal(harness.downloadCount(), 0);
    assert.equal(harness.settings().pendingUpdate?.version, "1.2.5");
    assert.equal(harness.quitAndInstalls(), 1);
  }).pipe(Effect.provide(harness.layer), Effect.scoped);
});
