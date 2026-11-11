import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import { DesktopSnapShotId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  screen: {
    on: vi.fn(),
    removeListener: vi.fn(),
    getAllDisplays: vi.fn(() => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]),
  },
}));

import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { SNAP_SHOT_EVENT_CHANNEL } from "../ipc/channels.ts";
import type * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import { makeFakeBrowserWindow } from "./DesktopWindow.test-fixtures.ts";
import { layerTest, makeSplashScenario } from "./DesktopWindow.testkit.ts";

const captureOne = DesktopSnapShotId.make("11111111-1111-4111-8111-111111111111");
const captureTwo = DesktopSnapShotId.make("22222222-2222-4222-8222-222222222222");

describe("DesktopWindow", () => {
  it("restores bounds when the window fits within a display or spans contiguous displays", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const spanningHorizontalBounds = { x: 1400, y: 80, width: 1100, height: 780 };
    const spanningVerticalBounds = { x: 120, y: 760, width: 1100, height: 780 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];
    const verticalDisplays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 1080, width: 1920, height: 1080 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(spanningHorizontalBounds, displays),
      spanningHorizontalBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(spanningVerticalBounds, verticalDisplays),
      spanningVerticalBounds,
    );
  });

  it("clamps bounds across a gap or dead space between displays while preserving size", () => {
    const spanningBounds = { x: 1400, y: 80, width: 1100, height: 780 };
    const gappedDisplays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 2120, y: 0, width: 1920, height: 1080 },
    ];
    assert.deepEqual(DesktopWindow.resolveInitialMainWindowBounds(spanningBounds, gappedDisplays), {
      x: 820,
      y: 80,
      width: 1100,
      height: 780,
    });

    const deadSpaceBounds = { x: 1400, y: 300, width: 1320, height: 900 };
    const staggeredDisplays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(deadSpaceBounds, staggeredDisplays),
      { x: 1920, y: 300, width: 1320, height: 900 },
    );
  });

  it("preserves and clamps saved size when an external display is disconnected", () => {
    const primaryDisplay = { x: 0, y: 0, width: 1920, height: 1080 };

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds({ x: 2040, y: 80, width: 1320, height: 880 }, [
        primaryDisplay,
      ]),
      { x: 600, y: 80, width: 1320, height: 880 },
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds({ x: 2040, y: 80, width: 2200, height: 1200 }, [
        primaryDisplay,
      ]),
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(
        { x: 2040, y: 80, width: 1320, height: 880 },
        [],
      ),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it("rejects renderer navigations whose origin only serializes as null", () => {
    for (const applicationUrl of ["goat://app/", "goat-dev://app/"]) {
      assert.isTrue(
        DesktopWindow.isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: `${applicationUrl}threads?id=1#latest`,
        }),
        applicationUrl,
      );
    }
    for (const navigationUrl of [
      "goat://other/",
      "goat://app.example/",
      "goat://app:8080/",
      "goat://user@other/",
      "goat:app",
      "goat-dev://app/",
      "file:///etc/passwd",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "about:blank",
      "blob:goat://app/0b5e2c4a",
    ]) {
      assert.isFalse(
        DesktopWindow.isSameOriginRendererNavigation({
          applicationUrl: "goat://app/",
          navigationUrl,
        }),
        navigationUrl,
      );
    }
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "data:text/html,app",
        navigationUrl: "data:text/html,other",
      }),
    );
  });

  it.effect(
    "opens and reopens the window without backend readiness when local execution is disabled",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = layerTest({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          createdWindowOptions: [],
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
        });
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.createMainIfBackendReady;
          assert.equal(yield* Ref.get(createCount), 1);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(createCount), 2);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.dispatchMenuAction("new-thread");
          assert.equal(yield* Ref.get(createCount), 3);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("zooms main with a focused popup and reapplies preview zoom", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
        focusedWindow: popup.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.zoomMain("reset");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [-0.5, -1, -0.5, 0],
        );
        assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
        assert.equal(popup.setZoomLevel.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("zooms the app from Ctrl+wheel like the menu does", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const zoomChanged = fakeWindow.webContentsListeners.get("zoom-changed");
        if (!zoomChanged) return yield* Effect.die("zoom-changed listener was not registered");
        zoomChanged({}, "in");
        zoomChanged({}, "out");
        zoomChanged({}, "out");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [0.5, 0, -0.5],
        );
        assert.deepEqual(previewZoomReapplies, [0.5, 0, -0.5]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reloads and inspects the main window even when a popup has focus", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        focusedWindow: popup.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.runMainContentsCommand("reload");
        yield* desktopWindow.runMainContentsCommand("forceReload");
        yield* desktopWindow.runMainContentsCommand("toggleDevTools");

        assert.equal(fakeWindow.reload.mock.calls.length, 1);
        assert.equal(fakeWindow.reloadIgnoringCache.mock.calls.length, 1);
        assert.equal(fakeWindow.toggleDevTools.mock.calls.length, 1);
        assert.equal(popup.reload.mock.calls.length, 0);
        assert.equal(popup.reloadIgnoringCache.mock.calls.length, 0);
        assert.equal(popup.toggleDevTools.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("trusts the main window for desktop IPC before its page starts loading", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      // The preload's first sendSync arrives once loading starts; DesktopIpc only answers
      // the registered main window, so registration has to come first.
      const mainAtLoad: Array<Option.Option<Electron.BrowserWindow>> = [];
      fakeWindow.loadURL.mockImplementation(() => {
        mainAtLoad.push(Ref.getUnsafe(mainWindow));
        return Promise.resolve();
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
      }).pipe(Effect.provide(layerTest({ window: fakeWindow.window, createCount, mainWindow })));

      assert.isAbove(mainAtLoad.length, 0);
      assert.deepStrictEqual(mainAtLoad[0], Option.some(fakeWindow.window));
    }),
  );

  it.effect("uses persisted bounds when the window spans two connected displays", () =>
    Effect.gen(function* () {
      vi.mocked(Electron.screen.getAllDisplays).mockReturnValueOnce([
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } } as Electron.Display,
        { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } } as Electron.Display,
      ]);
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 1400, y: 80, width: 1100, height: 780 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(createdWindowOptions[0]?.width, 1100);
        assert.equal(createdWindowOptions[0]?.height, 780);
        assert.equal(createdWindowOptions[0]?.x, 1400);
        assert.equal(createdWindowOptions[0]?.y, 80);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("creates the main window with the material's options and attaches with them", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const materialAttachOptions: unknown[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        materialWindowOptions: { transparent: true },
        materialAttachOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(createdWindowOptions[0]?.transparent, true);
        assert.deepEqual(materialAttachOptions, [{ transparent: true }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not open main or splash windows once quitting has started", () =>
    Effect.gen(function* () {
      const fake = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      yield* Effect.gen(function* () {
        const windows = yield* DesktopWindow.DesktopWindow;
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);

        yield* windows.showConnectingSplash;
        yield* windows.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* windows.activate;
        yield* windows.dispatchMenuAction("open-settings");
        for (const creation of [
          windows.createMain,
          windows.ensureMain,
          windows.revealOrCreateMain,
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(creation)));
        }

        assert.equal(yield* Ref.get(createCount), 0);
        assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
        assert.equal(fake.send.mock.calls.length, 0);
      }).pipe(Effect.provide(layerTest({ window: fake.window, createCount, mainWindow })));
    }),
  );

  it.effect.each(["main", "splash"] as const)(
    "destroys a %s window when quit races native creation without loading or revealing it",
    (kind) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const creationStarted = yield* Deferred.make<void>();
        const releaseCreation = yield* Deferred.make<void>();
        const reveal = vi.fn();
        const layer = layerTest({
          window: fake.window,
          createCount,
          mainWindow,
          onWindowCreate: Deferred.succeed(creationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCreation)),
          ),
          destroyAll: Effect.sync(() => fake.isDestroyed.mockReturnValue(true)),
          onReveal: reveal,
        });

        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          const state = yield* DesktopState.DesktopState;
          const fiber = yield* (
            kind === "splash"
              ? windows.showConnectingSplash
              : windows.handleBackendReady(new URL("http://127.0.0.1:3773"))
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(creationStarted);
          yield* Ref.set(state.quitting, true);
          yield* Deferred.succeed(releaseCreation, undefined);
          assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
          assert.equal(yield* Ref.get(createCount), 1);
          assert.isTrue(fake.window.isDestroyed());
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          assert.equal(fake.loadURL.mock.calls.length, 0);
          assert.equal(fake.openDevTools.mock.calls.length, 0);
          assert.equal(reveal.mock.calls.length, 0);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["backend ready", "activation", "renderer event"] as const)(
    "quietly cancels %s when quit races preview cleanup",
    (entry) =>
      Effect.gen(function* () {
        const fake = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const previewStarted = yield* Deferred.make<void>();
        const releasePreview = yield* Deferred.make<void>();
        const reveal = vi.fn();
        const warnings: unknown[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Error") warnings.push(message);
        });
        const layer = layerTest({
          window: fake.window,
          createCount,
          mainWindow,
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
          setPreviewMainWindow: () =>
            Deferred.succeed(previewStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePreview)),
            ),
          destroyAll: Effect.sync(() => fake.isDestroyed.mockReturnValue(true)),
          onReveal: reveal,
        });

        yield* Effect.gen(function* () {
          const windows = yield* DesktopWindow.DesktopWindow;
          const state = yield* DesktopState.DesktopState;
          const creation =
            entry === "backend ready"
              ? windows.handleBackendReady(new URL("http://127.0.0.1:3773"))
              : entry === "activation"
                ? windows.activate
                : windows.dispatchMenuAction("open-settings");
          const fiber = yield* creation.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(previewStarted);
          yield* Ref.set(state.quitting, true);
          // Cover both an already-destroyed window and one shutdown has yet to destroy.
          fake.isDestroyed.mockReturnValue(entry !== "backend ready");
          yield* Deferred.succeed(releasePreview, undefined);

          assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
          assert.isTrue(fake.window.isDestroyed());
          assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
          assert.equal(fake.loadURL.mock.calls.length, 0);
          assert.equal(fake.openDevTools.mock.calls.length, 0);
          assert.equal(fake.send.mock.calls.length, 0);
          assert.equal(reveal.mock.calls.length, 0);
          assert.deepEqual(warnings, []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false })),
          ),
        );
      }),
  );

  it.effect("persists normal bounds and state for a maximized window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.isMaximized.mockReturnValue(true);
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 2040, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        const move = fakeWindow.windowListeners.get("move");
        if (!close || !move) {
          return yield* Effect.die("window lifecycle listeners were not registered");
        }

        close();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);

        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 80, y: 60, width: 1280, height: 840 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: -32_000, y: -32_000, width: 160, height: 28 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 180, y: 120, width: 1440, height: 960 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 180, y: 120, width: 1440, height: 960 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("maps macOS horizontal swipes to available history navigation", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const swipe = fakeWindow.windowListeners.get("swipe");
        assert.isDefined(swipe);
        if (!swipe) return;
        const history = fakeWindow.navigationHistory;

        swipe({}, "left");
        assert.equal(history.goBack.mock.calls.length, 1);
        assert.equal(history.goForward.mock.calls.length, 0);
        swipe({}, "right");
        assert.equal(history.goForward.mock.calls.length, 1);

        swipe({}, "up");
        swipe({}, "down");
        history.canGoBack.mockReturnValue(false);
        history.canGoForward.mockReturnValue(false);
        swipe({}, "left");
        swipe({}, "right");
        assert.equal(history.goBack.mock.calls.length, 1);
        assert.equal(history.goForward.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists the current main window bounds before the window closes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 240, y: 160, width: 1410, height: 930 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));

        assert.deepEqual(mainWindowBoundsUpdates, [
          {
            x: 240,
            y: 160,
            width: 1410,
            height: 930,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        for (const [url, expectedPrevented] of [
          ["goat-dev://app/threads?id=1#latest", false],
          ["goat-dev://other/", true],
          ["goat://app/", true],
        ] as const) {
          const preventDefault = vi.fn();
          willNavigate({ preventDefault }, url);
          assert.equal(preventDefault.mock.calls.length, expectedPrevented ? 1 : 0, url);
        }
        assert.deepEqual(openedExternalUrls, []);

        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("offers to copy the bare address when right-clicking a mailto link", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const popup = yield* Deferred.make<ElectronMenu.ElectronMenuTemplateInput>();
      const copied = yield* Deferred.make<string>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onPopupTemplate: (input) => Deferred.succeed(popup, input),
        onCopyText: (text) => Deferred.succeed(copied, text),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const contextMenu = fakeWindow.webContentsListeners.get("context-menu");
        if (!contextMenu) {
          return yield* Effect.die("context-menu listener was not registered");
        }
        contextMenu(
          { preventDefault: vi.fn() },
          {
            linkURL: "mailto:restaurant%40example.com?subject=Hi",
            misspelledWord: "",
            dictionarySuggestions: [],
            mediaType: "none",
            editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
          },
        );

        const { template } = yield* Deferred.await(popup);
        const copyEmail = template.find((item) => item.label === "Copy Email Address");
        assert.isDefined(
          copyEmail,
          `no "Copy Email Address" item in ${JSON.stringify(template.map((item) => item.label ?? item.role ?? item.type))}`,
        );
        copyEmail?.click?.(
          {} as Electron.MenuItem,
          fakeWindow.window,
          {} as Electron.KeyboardEvent,
        );
        assert.equal(yield* Deferred.await(copied), "restaurant@example.com");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retries opening the real main on activate when a failed post-readiness open left only the splash",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        const main = makeFakeBrowserWindow();
        const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          const readyExit = yield* Effect.exit(
            desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
          );
          assert.equal(readyExit._tag, "Failure");
          assert.equal(yield* Ref.get(scenario.createCalls), 2);
          assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));

          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 3);
          const registeredMain = yield* Ref.get(scenario.mainWindow);
          assert.isTrue(Option.isSome(registeredMain));
          assert.equal(Option.getOrThrow(registeredMain), main.window);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect("delivers capture completion and late errors without taking focus back", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      let foreground = "Discord";
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.send.mockImplementation(() => {
        operations.push("send");
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: () => {
          foreground = "T3 Code";
          operations.push("reveal");
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* desktopWindow.dispatchSnapShotEvent({ type: "started", id: captureOne });
        assert.equal(foreground, "T3 Code");
        foreground = "Explorer";
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });
        yield* desktopWindow.dispatchSnapShotEvent({ type: "failed", id: captureTwo });

        assert.equal(foreground, "Explorer");
        assert.deepEqual(operations, ["send", "reveal", "send", "send"]);
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [SNAP_SHOT_EVENT_CHANNEL, { type: "started", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "ready", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "failed", id: captureTwo }],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not reopen a closed main window for a completed capture", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const onReveal = vi.fn();
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow, onReveal });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        fakeWindow.isDestroyed.mockReturnValue(true);
        yield* Ref.set(mainWindow, Option.none());
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.send.mock.calls.length, 0);
        assert.equal(onReveal.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
