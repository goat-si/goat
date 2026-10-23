import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

function layerElectronApp(
  appListeners: Map<string, (...args: readonly unknown[]) => void>,
  quit: Effect.Effect<void> = Effect.void,
) {
  const registerListener = (eventName: string, listener: (...args: readonly unknown[]) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appListeners.set(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appListeners.delete(eventName);
        }),
    ).pipe(Effect.asVoid);

  return Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    systemLocale: Effect.succeed("en-US"),
    whenReady: Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    quit,
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
    onBeforeQuitForUpdate: (listener) => registerListener("before-quit-for-update", listener),
    on: (eventName, listener) =>
      registerListener(eventName, listener as unknown as (...args: readonly unknown[]) => void),
  } satisfies ElectronApp.ElectronApp["Service"]);
}

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
});

function layerElectronWindow(destroyAll: Effect.Effect<void> = Effect.void) {
  return Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window creation"),
    main: Effect.die("unexpected main window read"),
    currentMainOrFirst: Effect.die("unexpected current window read"),
    focusedMainOrFirst: Effect.die("unexpected focused window read"),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll,
    syncAllAppearance: () => Effect.void,
  });
}

function layerDesktopWindow(
  input: {
    readonly activate?: Effect.Effect<void>;
    readonly flushMainWindowBounds?: Effect.Effect<void>;
  } = {},
) {
  return Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: input.activate ?? Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: input.flushMainWindowBounds ?? Effect.void,
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchSnapShotEvent: () => Effect.void,
    zoomMain: () => Effect.void,
    runMainContentsCommand: () => Effect.void,
    syncAppearance: Effect.void,
  });
}

const initialUpdateState = createInitialDesktopUpdateState(
  "1.2.3",
  { hostArch: "x64", appArch: "x64", runningUnderArm64Translation: false },
  "latest",
);
function layerUpdates(input: Partial<DesktopUpdates.DesktopUpdates["Service"]> = {}) {
  return Layer.succeed(DesktopUpdates.DesktopUpdates, {
    getState: Effect.succeed(initialUpdateState),
    isActionActive: Effect.succeed(false),
    isInstallActive: Effect.succeed(false),
    subscribe: Effect.die("unexpected subscribe"),
    emitState: Effect.void,
    disabledReason: Effect.succeedNone,
    configure: Effect.void,
    setChannel: () => Effect.die("unexpected setChannel"),
    setInstallPolicy: () => Effect.die("unexpected setInstallPolicy"),
    check: () => Effect.die("unexpected check"),
    download: Effect.die("unexpected download"),
    install: Effect.die("unexpected install"),
    installPrepared: () => Effect.die("unexpected installPrepared"),
    ...input,
  });
}

describe("DesktopLifecycle", () => {
  it.effect.each(["install-on-quit", "restart-when-idle"] as const)(
    "installs a downloaded update on quit under %s and waits for updater-controlled quit without shutdown",
    (installPolicy) =>
      Effect.gen(function* () {
        const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
        const installationStarted = yield* Deferred.make<void>();
        const allowInstallation = yield* Deferred.make<void>();
        const installationReturned = yield* Deferred.make<void>();
        const events: string[] = [];
        const updateState = {
          ...initialUpdateState,
          installPolicy,
          downloadedVersion: "1.2.4",
        };
        const layer = DesktopLifecycle.layer.pipe(
          Layer.provideMerge(
            layerUpdates({
              getState: Effect.succeed(updateState),
              installPrepared: (version) =>
                Effect.gen(function* () {
                  assert.equal(version, "1.2.4");
                  events.push("install");
                  yield* Deferred.succeed(installationStarted, undefined);
                  yield* Deferred.await(allowInstallation);
                  yield* Deferred.succeed(installationReturned, undefined);
                  return { accepted: true, completed: false, failed: false, state: updateState };
                }),
            }),
          ),
          Layer.provideMerge(
            layerElectronApp(
              appListeners,
              Effect.sync(() => {
                events.push("quit");
              }),
            ),
          ),
          Layer.provideMerge(layerElectronTheme),
          Layer.provideMerge(
            layerElectronWindow(
              Effect.sync(() => {
                events.push("destroy");
              }),
            ),
          ),
          Layer.provideMerge(
            layerDesktopWindow({
              flushMainWindowBounds: Effect.sync(() => {
                events.push("flush");
              }),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              platform: "darwin",
              isDevelopment: false,
            } as DesktopEnvironment.DesktopEnvironment["Service"]),
          ),
          Layer.provideMerge(
            Layer.succeed(DesktopShutdown.DesktopShutdown, {
              request: Effect.sync(() => {
                events.push("shutdown");
              }),
              awaitRequest: Effect.never,
              markComplete: Effect.void,
              awaitComplete: Effect.void,
              isComplete: Effect.succeed(false),
            }),
          ),
          Layer.provideMerge(DesktopState.layer),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
            let prevented = 0;
            const event = {
              preventDefault: () => {
                prevented += 1;
              },
            } as Electron.Event;
            appListeners.get("before-quit")?.(event);
            appListeners.get("before-quit")?.(event);
            yield* Deferred.await(installationStarted);
            assert.equal(prevented, 2);
            assert.deepEqual(events, ["flush", "install"]);
            assert.isFalse(yield* Ref.get((yield* DesktopState.DesktopState).quitting));
            yield* Deferred.succeed(allowInstallation, undefined);
            yield* Deferred.await(installationReturned);
            yield* Effect.yieldNow;
            assert.deepEqual(events, ["flush", "install"]);
            appListeners.get("before-quit-for-update")?.();
            appListeners.get("before-quit")?.(event);
            assert.equal(prevented, 2);
            assert.deepEqual(events, ["flush", "install", "destroy"]);
          }),
        ).pipe(Effect.provide(layer));
      }),
  );

  [
    "refused",
    "failed",
    "not-ready",
    "bounds-defect",
    "state-defect",
    "install-defect",
    "accepted-then-failed",
  ].forEach((outcome) => {
    it.effect(
      outcome === "accepted-then-failed"
        ? "accepted install then failure then second before-quit is handled"
        : `handles quit installation ${outcome} without losing the ordinary quit path`,
      () =>
        Effect.gen(function* () {
          const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
          const installationReturned = yield* Deferred.make<void>();
          const quitCalled = yield* Deferred.make<void>();
          const events: string[] = [];
          let installActive = false;
          let installations = 0;
          const updateState = {
            ...initialUpdateState,
            installPolicy: "install-on-quit" as const,
            downloadedVersion: outcome === "not-ready" ? null : "1.2.4",
          };
          const layer = DesktopLifecycle.layer.pipe(
            Layer.provideMerge(
              layerUpdates({
                getState:
                  outcome === "state-defect"
                    ? Effect.die("state defect")
                    : Effect.succeed(updateState),
                isInstallActive: Effect.sync(() => installActive),
                installPrepared: () =>
                  (outcome === "install-defect"
                    ? Effect.die("install defect")
                    : Effect.sync(() => {
                        installations += 1;
                        installActive = outcome === "accepted-then-failed" && installations === 1;
                      })
                  ).pipe(
                    Effect.andThen(Deferred.succeed(installationReturned, undefined)),
                    Effect.map(() => ({
                      accepted:
                        outcome === "failed" ||
                        (outcome === "accepted-then-failed" && installations === 1),
                      completed: false,
                      failed: outcome === "failed",
                      state: updateState,
                    })),
                  ),
              }),
            ),
            Layer.provideMerge(
              layerElectronApp(
                appListeners,
                Effect.sync(() => {
                  events.push("quit");
                }).pipe(Effect.andThen(Deferred.succeed(quitCalled, undefined)), Effect.asVoid),
              ),
            ),
            Layer.provideMerge(layerElectronTheme),
            Layer.provideMerge(layerElectronWindow()),
            Layer.provideMerge(
              layerDesktopWindow({
                flushMainWindowBounds:
                  outcome === "bounds-defect" ? Effect.die("bounds defect") : Effect.void,
              }),
            ),
            Layer.provideMerge(
              Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                platform: "darwin",
                isDevelopment: false,
              } as DesktopEnvironment.DesktopEnvironment["Service"]),
            ),
            Layer.provideMerge(
              Layer.succeed(DesktopShutdown.DesktopShutdown, {
                request: Effect.sync(() => {
                  events.push("shutdown");
                }),
                awaitRequest: Effect.never,
                markComplete: Effect.void,
                awaitComplete: Effect.void,
                isComplete: Effect.succeed(false),
              }),
            ),
            Layer.provideMerge(DesktopState.layer),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* (yield* DesktopLifecycle.DesktopLifecycle).register;
              appListeners.get("before-quit")?.({
                preventDefault: () => undefined,
              } as Electron.Event);
              if (outcome === "accepted-then-failed") {
                yield* Deferred.await(installationReturned);
                yield* Effect.yieldNow;
                assert.equal(installations, 1);
                installActive = false;
                appListeners.get("before-quit")?.({
                  preventDefault: () => undefined,
                } as Electron.Event);
                yield* Deferred.await(quitCalled);
                assert.equal(installations, 2);
                assert.deepEqual(events, ["shutdown", "quit"]);
              } else if (outcome === "failed") {
                yield* Deferred.await(installationReturned);
                yield* Effect.yieldNow;
                assert.deepEqual(events, []);
                assert.isFalse(yield* Ref.get((yield* DesktopState.DesktopState).quitting));
              } else {
                yield* Deferred.await(quitCalled);
                assert.deepEqual(
                  events,
                  outcome.endsWith("defect") ? ["quit"] : ["shutdown", "quit"],
                );
              }
            }),
          ).pipe(Effect.provide(layer));
        }),
    );
  });

  it.effect.each(["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>)(
    "lets the updater's quit event proceed on %s",
    (platform) => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let windowsDestroyed = false;
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerUpdates()),
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(
          layerElectronWindow(
            Effect.sync(() => {
              windowsDestroyed = true;
            }),
          ),
        ),
        Layer.provideMerge(layerDesktopWindow()),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();
          yield* Effect.yieldNow;

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );
          assert.isTrue(windowsDestroyed);

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it.effect("destroys windows before waiting for backend shutdown", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const shutdownRequested = yield* Deferred.make<void>();
      const allowShutdown = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();
      const events: string[] = [];

      const quit = Effect.sync(() => {
        events.push("quit");
      }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined)), Effect.asVoid);
      const destroyAll = Effect.sync(() => {
        events.push("destroy");
      });
      const flushMainWindowBounds = Effect.sync(() => {
        events.push("flush");
      });

      const layerDesktopShutdown = Layer.succeed(DesktopShutdown.DesktopShutdown, {
        request: Effect.sync(() => {
          events.push("request");
        }).pipe(Effect.andThen(Deferred.succeed(shutdownRequested, undefined)), Effect.asVoid),
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Deferred.succeed(allowShutdown, undefined).pipe(Effect.asVoid),
        awaitComplete: Deferred.await(allowShutdown),
        isComplete: Deferred.isDone(allowShutdown),
      });

      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerUpdates()),
        Layer.provideMerge(layerElectronApp(appListeners, quit)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow(destroyAll)),
        Layer.provideMerge(layerDesktopWindow({ flushMainWindowBounds })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(layerDesktopShutdown),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          const event = { preventDefault: () => undefined } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          yield* Deferred.await(shutdownRequested);
          const eventsBeforeCleanup = [...events];
          yield* Deferred.succeed(allowShutdown, undefined);
          yield* Deferred.await(quitRequested);

          assert.deepEqual(eventsBeforeCleanup, ["flush", "destroy", "request"]);
          assert.deepEqual(events, ["flush", "destroy", "request", "quit"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("ignores app activation while quitting", () =>
    Effect.gen(function* () {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      let activationCount = 0;
      const activate = Effect.sync(() => {
        activationCount += 1;
      });
      const layerEnvironment = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform: "darwin",
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(layerUpdates()),
        Layer.provideMerge(layerElectronApp(appListeners)),
        Layer.provideMerge(layerElectronTheme),
        Layer.provideMerge(layerElectronWindow()),
        Layer.provideMerge(layerDesktopWindow({ activate })),
        Layer.provideMerge(layerEnvironment),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          const state = yield* DesktopState.DesktopState;
          yield* lifecycle.register;
          yield* Ref.set(state.quitting, true);

          appListeners.get("activate")?.();

          assert.equal(activationCount, 0);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
