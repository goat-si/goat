import { DesktopUpdateStateSchema, type DesktopUpdateState } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { resolveStartupRecoveryOffer } from "./DesktopStartupRecoveryView.ts";

import { it as effectIt, assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Electron from "electron";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { makeHarness as makeUpdatesHarness } from "../updates/updatesTestHarness.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopStartupRecovery from "./DesktopStartupRecovery.ts";
import { ACTION_ORIGIN, buildStartupRecoveryHtml } from "./DesktopStartupRecoveryView.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2")).toEqual({
      _tag: "Checking",
    });
  });

  it("offers the last version that started when no update exists", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2" });
  });

  it("falls back to the releases page when this version never started", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3")).toEqual({
      _tag: "Releases",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null)).toEqual({
      _tag: "Releases",
    });
  });
});

const makeRecoveryHarness = Effect.fn("test.makeRecoveryHarness")(function* (
  initial: DesktopUpdateState,
  mainExists = false,
  installAccepted = true,
) {
  const path = yield* Path.Path;
  const rendered = Promise.withResolvers<string>();
  let renderCount = 0;
  const installed = yield* Queue.unbounded<{ version: string; waitForCheck: boolean }>();
  const opened = yield* Queue.unbounded<unknown>();
  const copied = yield* Queue.unbounded<string>();
  const quit = yield* Queue.unbounded<void>();
  const pages = yield* Queue.unbounded<string>();
  const written = yield* Queue.unbounded<string>();
  const checked = yield* Deferred.make<void>();
  const closed = Promise.withResolvers<void>();
  let navigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
  let openWindow: Parameters<Electron.WebContents["setWindowOpenHandler"]>[0] | undefined;
  let destroyed = false;
  const window = {
    isDestroyed: () => destroyed,
    loadURL: (url: string) => {
      renderCount += 1;
      const html = decodeURIComponent(url.split(",").slice(1).join(","));
      rendered.resolve(html);
      return Effect.runPromise(Queue.offer(pages, html)).then(() => undefined);
    },
    once: () => undefined,
    close: () => {
      destroyed = true;
      closed.resolve();
    },
    webContents: {
      setWindowOpenHandler: (handler: typeof openWindow) => {
        openWindow = handler;
      },
      on: (_name: string, callback: typeof navigate) => {
        navigate = callback;
      },
    },
  } as unknown as Electron.BrowserWindow;
  const layer = Layer.mergeAll(
    DesktopState.layer,
    FileSystem.layerNoop({
      readFileString: () => Effect.succeed("0.1.2-nightly.20261026.280"),
      writeFileString: (_path, value) => Queue.offer(written, value).pipe(Effect.asVoid),
    }),
    Layer.mock(DesktopEnvironment.DesktopEnvironment)({
      path,
      stateDir: "/sandbox",
      logDir: "/sandbox/logs",
      appVersion: initial.currentVersion,
      platform: "darwin",
      processArch: "arm64",
    }),
    Layer.mock(ElectronApp.ElectronApp)({
      on: () => Effect.void,
      quit: Queue.offer(quit, undefined).pipe(Effect.asVoid),
    }),
    Layer.mock(ElectronTheme.ElectronTheme)({ shouldUseDarkColors: Effect.succeed(false) }),
    Layer.mock(ElectronShell.ElectronShell)({
      openExternal: (url) => Queue.offer(opened, url).pipe(Effect.as(true)),
      copyText: (text) => Queue.offer(copied, text).pipe(Effect.asVoid),
    }),
    Layer.mock(ElectronWindow.ElectronWindow)({
      main: Effect.succeed(mainExists ? Option.some(window) : Option.none()),
      create: () => Effect.succeed(window),
    }),
    Layer.mock(DesktopUpdates.DesktopUpdates)({
      subscribe: Effect.succeed({ latest: initial, changes: Stream.empty }),
      getState: Effect.succeed(initial),
      check: () =>
        Deferred.succeed(checked, undefined).pipe(Effect.as({ checked: true, state: initial })),
      installPrepared: (version, options) =>
        Queue.offer(installed, { version, waitForCheck: options?.waitForCheck ?? false }).pipe(
          Effect.as({
            accepted: installAccepted,
            completed: installAccepted,
            failed: false,
            state: initial,
          }),
        ),
    }),
  );
  return {
    layer,
    rendered,
    renderCount: () => renderCount,
    installed,
    opened,
    copied,
    quit,
    pages,
    written,
    checked,
    closed,
    navigate: (url: string) => {
      if (!navigate) throw new Error("recovery navigation handler was not registered");
      let prevented = false;
      navigate(
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        url,
      );
      return prevented;
    },
    popup: (url: string) => {
      if (!openWindow) throw new Error("recovery popup handler was not registered");
      return openWindow({
        url,
        frameName: "",
        features: "",
        disposition: "new-window",
        referrer: { url: "", policy: "default" },
      });
    },
    click: (action: string) => navigate?.({ preventDefault() {} }, `${ACTION_ORIGIN}/${action}`),
  };
});

effectIt.effect(
  "opens recovery after failure, installs through GOAT's updater, and closes when ready",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRecoveryHarness(
        Schema.decodeSync(DesktopUpdateStateSchema)(
          updateState({ status: "downloaded", downloadedVersion: "0.1.4" }),
        ),
      );
      yield* Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* DesktopStartupRecovery.listen;
        yield* SubscriptionRef.set(state.primaryBackendStartup, {
          _tag: "Failing",
          reason: "The server could not start (code=1).",
          output: "Cannot find module 'sample-missing'",
        });
        const html = yield* Effect.promise(() => harness.rendered.promise);
        assert.include(html, "sample-missing");
        assert.include(html, "Update to 0.1.4");
        yield* Deferred.await(harness.checked);
        harness.click("update");
        assert.deepEqual(yield* Queue.take(harness.installed), {
          version: "0.1.4",
          waitForCheck: true,
        });
        yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
        yield* Effect.promise(() => harness.closed.promise);
        assert.equal(yield* Queue.take(harness.written), "0.1.3");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(Path.layer)),
);

effectIt.effect(
  "reinstallation opens the last successful nightly in GOAT's release repository",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeRecoveryHarness(updateState({ status: "up-to-date" }));
      yield* Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* DesktopStartupRecovery.listen;
        yield* SubscriptionRef.set(state.primaryBackendStartup, {
          _tag: "Failing",
          reason: "Server startup timed out.",
          output: "",
        });
        yield* Effect.promise(() => harness.rendered.promise);
        harness.click("reinstall");
        assert.equal(
          yield* Queue.take(harness.opened),
          "https://github.com/goat-si/goat-releases/releases/tag/v0.1.2-nightly.20261026.280",
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.provide(Path.layer)),
);

effectIt.effect("keeps recovery closed once the main window exists", () =>
  Effect.gen(function* () {
    const harness = yield* makeRecoveryHarness(updateState({ status: "up-to-date" }), true);
    yield* Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      yield* DesktopStartupRecovery.listen;
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server restarting.",
        output: "",
      });
      yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
      yield* Queue.take(harness.written);
      assert.equal(harness.renderCount(), 0);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(Path.layer)),
);

effectIt.effect.each([false, true])(
  "waits for pending-update persistence before installing (persistence fails: %s)",
  (persistenceFails) =>
    Effect.gen(function* () {
      const persistenceStarted = yield* Deferred.make<void>();
      const releasePersistence = yield* Deferred.make<void>();
      const downloadReturned = yield* Deferred.make<void>();
      const installerReached = yield* Deferred.make<void>();
      const updaterHarness = makeUpdatesHarness({
        installPolicy: "paused",
        beforeSetPendingUpdate: Deferred.succeed(persistenceStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releasePersistence)),
        ),
        ...(persistenceFails
          ? {
              setPendingUpdateError: new DesktopAppSettings.DesktopSettingsWriteError({
                operation: "replace-settings-file",
                path: "/sandbox/settings.json",
                cause: new Error("fixture write failed"),
              }),
            }
          : {}),
        downloadUpdate: Effect.sync(() => {
          updaterHarness.emit("update-downloaded", { version: "1.2.4" });
        }).pipe(Effect.andThen(Deferred.await(persistenceStarted))),
        quitAndInstall: Deferred.succeed(installerReached, undefined).pipe(Effect.asVoid),
      });
      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        updaterHarness.emit("update-available", { version: "1.2.4" });
        const available = Option.getOrThrow(
          yield* changes.pipe(
            Stream.filter((state) => state.status === "available"),
            Stream.runHead,
          ),
        );
        const harness = yield* makeRecoveryHarness(available);
        yield* Effect.gen(function* () {
          const state = yield* DesktopState.DesktopState;
          yield* DesktopStartupRecovery.listen.pipe(
            Effect.provideService(
              DesktopUpdates.DesktopUpdates,
              DesktopUpdates.DesktopUpdates.of({
                ...updates,
                check: () =>
                  Deferred.succeed(harness.checked, undefined).pipe(
                    Effect.as({ checked: true, state: available }),
                  ),
                download: updates.download.pipe(
                  Effect.tap(() => Deferred.succeed(downloadReturned, undefined)),
                ),
              }),
            ),
          );
          yield* SubscriptionRef.set(state.primaryBackendStartup, {
            _tag: "Failing",
            reason: "The server could not start.",
            output: "Fixture startup failure",
          });
          yield* Effect.promise(() => harness.rendered.promise);
          yield* Deferred.await(harness.checked);
          harness.click("update");
          yield* Deferred.await(downloadReturned);
          assert.isNull((yield* updates.getState).downloadedVersion);
          assert.equal(updaterHarness.quitAndInstalls(), 0);
          yield* Deferred.succeed(releasePersistence, undefined);
          if (persistenceFails) {
            const failurePage = Option.getOrThrow(
              yield* Stream.fromQueue(harness.pages).pipe(
                Stream.filter((html) => html.includes("Could not persist the downloaded update")),
                Stream.runHead,
              ),
            );
            assert.include(failurePage, "Retry the download.");
            assert.equal(updaterHarness.quitAndInstalls(), 0);
          } else {
            yield* Deferred.await(installerReached);
            assert.equal(updaterHarness.quitAndInstalls(), 1);
            assert.equal(updaterHarness.settings().pendingUpdate?.version, "1.2.4");
          }
          assert.equal(updaterHarness.downloadCount(), 1);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.provide(updaterHarness.layer));
    }),
);

effectIt.effect("shows an installation refusal in the recovery window", () =>
  Effect.gen(function* () {
    const harness = yield* makeRecoveryHarness(
      updateState({ status: "downloaded", downloadedVersion: "0.1.4" }),
      false,
      false,
    );
    yield* Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      yield* DesktopStartupRecovery.listen;
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "The server could not start.",
        output: "",
      });
      yield* Effect.promise(() => harness.rendered.promise);
      harness.click("update");
      const html = Option.getOrThrow(
        yield* Stream.fromQueue(harness.pages).pipe(
          Stream.filter((page) =>
            page.includes("GOAT could not start installing the update. Try again."),
          ),
          Stream.runHead,
        ),
      );
      assert.include(html, 'role="status"');
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(Path.layer)),
);

effectIt.effect("cancels untrusted recovery navigation and denies every popup", () =>
  Effect.gen(function* () {
    const harness = yield* makeRecoveryHarness(
      updateState({ status: "downloaded", downloadedVersion: "0.1.4" }),
    );
    yield* Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      yield* DesktopStartupRecovery.listen;
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "The server could not start.",
        output: "Fixture output",
      });
      yield* Effect.promise(() => harness.rendered.promise);
      const denied = [
        "https://example.invalid/update",
        `${ACTION_ORIGIN}/unknown`,
        "https://startup-recovery.invalid.evil.invalid/update",
        "https://startup-recovery.invalid@evil.invalid/quit",
        "http://startup-recovery.invalid/releases",
        `${ACTION_ORIGIN}/update?version=9.9.9`,
        `${ACTION_ORIGIN}/copy#fragment`,
        "javascript:alert('fixture')",
      ];
      for (const url of denied) {
        assert.isTrue(harness.navigate(url), url);
        assert.deepEqual(harness.popup(url), { action: "deny" }, url);
      }
      assert.deepEqual(harness.popup(`${ACTION_ORIGIN}/update`), { action: "deny" });
      assert.isTrue(harness.navigate(`${ACTION_ORIGIN}/copy`));
      assert.include(yield* Queue.take(harness.copied), "Fixture output");
      assert.equal(yield* Queue.size(harness.installed), 0);
      assert.equal(yield* Queue.size(harness.opened), 0);
      assert.equal(yield* Queue.size(harness.quit), 0);
      assert.equal(yield* Queue.size(harness.copied), 0);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(Path.layer)),
);

it("renders hostile server output as text rather than recovery links or markup", () => {
  const html = buildStartupRecoveryHtml({
    appVersion: "0.1.3",
    failure: {
      reason: '<img src=x onerror="alert(1)"> & startup failed',
      output: `</pre><a href="${ACTION_ORIGIN}/quit">Quit</a><script>alert('fixture')</script>`,
    },
    offer: { _tag: "Releases" },
    logDir: "/sandbox/logs",
  });
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; startup failed");
  expect(html).toContain(
    `&lt;/pre&gt;&lt;a href=&quot;${ACTION_ORIGIN}/quit&quot;&gt;Quit&lt;/a&gt;&lt;script&gt;alert(&#39;fixture&#39;)&lt;/script&gt;`,
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script>");
});
