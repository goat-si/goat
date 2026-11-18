import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import {
  EDITORS,
  REMOTE_CAPABLE_EDITOR_IDS,
  type DesktopEnvironmentBootstrap,
} from "@goat/contracts";
import { resolveEditorCommand } from "@goat/shared/editor";

const { focusedWebContents, ownerWindow, popup } = vi.hoisted(() => ({
  focusedWebContents: vi.fn(),
  ownerWindow: vi.fn(),
  popup: vi.fn(),
}));
vi.mock("electron", () => ({
  webContents: { getFocusedWebContents: focusedWebContents },
  BrowserWindow: { fromWebContents: ownerWindow },
  Menu: { buildFromTemplate: () => ({ popup }) },
}));

import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopHeadlessServer from "../../backend/DesktopHeadlessServer.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../../wsl/DesktopWslEnvironment.ts";
import { toLocalBackendPath } from "./folderPaths.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getRelayTelemetryEnabled,
  pickProjectFavicon,
  probeRemoteEditors,
  showContextMenu,
  syncHtmlFullscreen,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeedSome(readyWslConfig),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

const backendConfigurationLayer = Layer.succeed(
  DesktopBackendConfiguration.DesktopBackendConfiguration,
  {
    resolvePrimary: Effect.die("unexpected resolvePrimary"),
    resolvePrimaryLabel: Effect.succeed("Windows"),
    resolveWsl: () => Effect.die("unexpected resolveWsl"),
    currentBootstrapToken: Effect.succeed("current-window-token"),
  } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
);

const bootstrapsLayer = (
  instances: ReadonlyArray<DesktopBackendManager.DesktopBackendInstance>,
  headless: Option.Option<DesktopEnvironmentBootstrap> = Option.none(),
) =>
  Layer.mergeAll(
    DesktopBackendPool.layerTest([...instances]),
    backendConfigurationLayer,
    Layer.succeed(DesktopHeadlessServer.DesktopHeadlessServer, {
      bootstrap: Effect.succeed(headless),
      refresh: Effect.void,
    }),
  );

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the attached headless server after the desktop's own backends", () => {
    const headless: DesktopEnvironmentBootstrap = {
      id: DesktopHeadlessServer.HEADLESS_LOCAL_ENVIRONMENT_ID,
      label: "Headless server",
      runningDistro: null,
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
      accessToken: "headless-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    };
    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
        headless,
      ]);
    }).pipe(Effect.provide(bootstrapsLayer([defaultWslInstance], Option.some(headless))));
  });

  it.effect("hands out the current window's token to a backend launched with the secret", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "current-window-token",
        },
      ]);
    }).pipe(
      Effect.provide(
        bootstrapsLayer([
          {
            ...defaultWslInstance,
            currentConfig: Effect.succeedSome({
              ...readyWslConfig,
              bootstrap: {
                ...readyWslConfig.bootstrap,
                desktopBootstrapSecret: "desktop-secret",
              },
            }),
          },
        ]),
      ),
    ),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome(retryingConfig),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(bootstrapsLayer([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeedSome({
        ...readyWslConfig,
        preflightFailure: Option.some({
          reason: "WSL probe timed out",
          fatal: false,
          retryLimit: 12,
        }),
      }),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(bootstrapsLayer([stoppedInstance])));
  });
});

describe("toLocalBackendPath", () => {
  it.effect("uses the running WSL distro and rejects paths owned by another backend", () =>
    Effect.gen(function* () {
      const convert = vi.fn(() => Option.some("/drives/c/Work $draft"));
      const primary = { ...defaultWslInstance, id: DesktopBackendManager.PRIMARY_INSTANCE_ID };
      const convertDrop = (backendId: string, path: string) =>
        toLocalBackendPath
          .handler({ backendId, path })
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                bootstrapsLayer([defaultWslInstance, primary]),
                DesktopAppSettings.layerTest(),
                DesktopWslEnvironment.layerTest({ windowsToWslPath: convert }),
              ),
            ),
            Effect.provideService(HostProcess.Platform, "win32"),
          );

      assert.equal(yield* convertDrop("primary", "C:\\Work $draft"), "/drives/c/Work $draft");
      assert.deepEqual(convert.mock.calls, [["Ubuntu", "C:\\Work $draft"]]);
      assert.equal(
        yield* convertDrop("wsl:default", "\\\\wsl.localhost\\ubuntu\\home\\dev"),
        "/home/dev",
      );
      assert.isNull(yield* convertDrop("wsl:default", "\\\\wsl$\\Debian\\home\\dev"));
      assert.isNull(yield* convertDrop("wsl:default", "\\\\remote\\share"));
      assert.isNull(yield* convertDrop("missing-backend", "C:\\Work"));
      assert.isNull(yield* convertDrop("wsl:default", "relative\\Work"));
      assert.lengthOf(convert.mock.calls, 1);
    }),
  );
});

describe("showContextMenu", () => {
  it.effect("passes keyboard origin to Electron and accepts requests from old preload", () => {
    const window = { id: 7, webContents: { getZoomFactor: () => 2 } } as Electron.BrowserWindow;
    return Effect.gen(function* () {
      popup
        .mockReset()
        .mockImplementation((options: Electron.PopupOptions) => options.callback?.());
      const items = [{ id: "copy", label: "Copy link" }];
      yield* showContextMenu.handler({ items, source: "keyboard", position: { x: 5, y: 8 } });
      assert.equal(popup.mock.lastCall?.[0].sourceType, "keyboard");
      assert.equal(popup.mock.lastCall?.[0].x, 10);
      assert.equal(popup.mock.lastCall?.[0].y, 16);

      yield* showContextMenu.handler({ items });
      assert.isUndefined(popup.mock.lastCall?.[0].sourceType);
      const refused = yield* showContextMenu
        .handler({ items, source: "unknown" })
        .pipe(Effect.exit);
      assert.equal(refused._tag, "Failure");
      assert.lengthOf(popup.mock.calls, 2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.effect(ElectronMenu.ElectronMenu, ElectronMenu.make),
          Layer.mock(ElectronWindow.ElectronWindow)({
            focusedMainOrFirst: Effect.succeedSome(window),
          }),
        ),
      ),
    );
  });
});

describe("getRelayTelemetryEnabled", () => {
  it.effect("reads the desktop host opt-out before returning the renderer policy", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* getRelayTelemetryEnabled.handler().pipe(
          Effect.provideService(HostProcess.Environment, {
            GOAT_TELEMETRY_ENABLED: "false",
          }),
        ),
      );
      assert.isTrue(
        yield* getRelayTelemetryEnabled
          .handler()
          .pipe(Effect.provideService(HostProcess.Environment, {})),
      );
    }),
  );
});

describe("pickProjectFavicon", () => {
  const pickerLayer = (
    pickFiles: () => Effect.Effect<Array<string>>,
    settings?: DesktopAppSettings.DesktopSettings,
  ) =>
    Layer.mergeAll(
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(ElectronWindow.ElectronWindow)({
        focusedMainOrFirst: Effect.succeedNone,
      }),
      DesktopAppSettings.layerTest(settings),
    );

  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon
        .handler("/project")
        .pipe(Effect.provide(pickerLayer(pickFiles)));

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: [
                  "avif",
                  "bmp",
                  "gif",
                  "ico",
                  "jpeg",
                  "jpg",
                  "png",
                  "svg",
                  "tif",
                  "tiff",
                  "webp",
                  "icns",
                ],
              },
            ],
          },
        ],
      ]);
    }),
  );

  it.effect("does not open a picker while the local environment is off", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          pickerLayer(pickFiles, {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          }),
        ),
      );

      assert.strictEqual(result, null);
      assert.strictEqual(pickFiles.mock.calls.length, 0);
    }),
  );
});

describe("syncHtmlFullscreen", () => {
  const fullscreenWindow = (fullscreen: boolean, { animatedExit = false } = {}) => {
    let current = fullscreen;
    let exiting = false;
    const queued: boolean[] = [];
    const leaveListeners: Array<() => void> = [];
    const navigationListeners: Array<
      (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
    > = [];
    const leave = () => {
      current = false;
      for (const listener of leaveListeners) listener();
    };
    // Like macOS, an animated exit keeps reporting fullscreen and queues requests until it ends.
    const setFullScreen = vi.fn((next: boolean) => {
      if (exiting) queued.push(next);
      else if (next) current = true;
      else if (!current) return;
      else if (animatedExit) exiting = true;
      else leave();
    });
    const finishExit = () => {
      exiting = false;
      leave();
      for (const next of queued.splice(0)) setFullScreen(next);
    };
    const window = {
      webContents: {
        id: 1,
        on: (
          event: string,
          listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
        ) => {
          if (event === "did-start-navigation") navigationListeners.push(listener);
        },
      },
      isDestroyed: () => false,
      isFullScreen: () => current,
      setFullScreen,
      on: (event: string, listener: () => void) => {
        if (event === "leave-full-screen") leaveListeners.push(listener);
      },
    } as unknown as Electron.BrowserWindow;
    const layer = Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(window) });
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      for (const listener of navigationListeners) listener(details);
    };
    return { window, setFullScreen, finishExit, navigate, layer };
  };
  const fromMainRenderer = { sender: { id: 1 } };

  it.effect("gives the screen back when the app reloads during fullscreen playback", () => {
    const { window, navigate, layer } = fullscreenWindow(false);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      navigate({ isMainFrame: false, isSameDocument: false });
      navigate({ isMainFrame: true, isSameDocument: true });
      assert.isTrue(window.isFullScreen());
      // The reloaded page has no fullscreen element and never reports leaving it.
      navigate({ isMainFrame: true, isSameDocument: false });
      assert.isFalse(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes the screen for the app's own fullscreen element and gives it back", () => {
    const { window, layer } = fullscreenWindow(false);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      assert.isTrue(window.isFullScreen());

      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);
      assert.isFalse(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a window the user had already made fullscreen", () => {
    const { window, setFullScreen, layer } = fullscreenWindow(true);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);

      assert.isTrue(window.isFullScreen());
      assert.strictEqual(setFullScreen.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("hands the window back once the user leaves OS fullscreen during playback", () => {
    const { window, layer } = fullscreenWindow(false);
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      window.setFullScreen(false);
      window.setFullScreen(true);
      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);

      assert.isTrue(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes the screen again when the video returns during an animated exit", () => {
    const { window, finishExit, layer } = fullscreenWindow(false, { animatedExit: true });
    return Effect.gen(function* () {
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);
      yield* syncHtmlFullscreen.handler(true, fromMainRenderer);
      finishExit();
      assert.isTrue(window.isFullScreen());

      yield* syncHtmlFullscreen.handler(false, fromMainRenderer);
      finishExit();
      assert.isFalse(window.isFullScreen());
    }).pipe(Effect.provide(layer));
  });
});

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "finds remote editors installed without PATH launchers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-remote-editors-" });
      for (const app of ["Cursor", "Visual Studio Code", "WebStorm"]) {
        const executable = path.join(
          home,
          "Applications",
          `${app}.app`,
          app === "WebStorm" ? "Contents/MacOS/webstorm" : "Contents/Resources/app/bin/code",
        );
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        yield* fs.writeFileString(executable, "#!/bin/sh\n");
        yield* fs.chmod(executable, 0o755);
      }
      const editors = yield* probeRemoteEditors.handler(undefined).pipe(
        Effect.provideService(HostProcess.Environment, {
          HOME: home,
          PATH: path.join(home, "empty"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.include(editors, "cursor");
      assert.include(editors, "vscode");
      assert.include(editors, "webstorm");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("probeRemoteEditors PATH scan", () => {
  const platform = HostProcess.Platform.defaultValue();
  const launcherName = (command: string) => (platform === "win32" ? `${command}.cmd` : command);

  const makeFakePath = Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-probe-path-" });
    const dirs = ["a", "b", "c", "d"].map((name) => path.join(root, name));
    for (const dir of dirs) yield* fs.makeDirectory(dir, { recursive: true });
    // Launchers in different PATH directories, deliberately not in REMOTE_CAPABLE_EDITOR_IDS order.
    for (const [dir, command] of [
      [dirs[2]!, "webstorm"],
      [dirs[0]!, "cursor"],
      [dirs[3]!, "code"],
      [dirs[1]!, "zeditor"],
    ] as const) {
      const file = path.join(dir, launcherName(command));
      yield* fs.writeFileString(file, "#!/bin/sh\n");
      if (platform !== "win32") yield* fs.chmod(file, 0o755);
    }
    return {
      root,
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: dirs.join(platform === "win32" ? ";" : ":"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    };
  });

  const countingFileSystem = (counter: { stat: number; reads: Map<string, number> }) =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return FileSystem.FileSystem.of({
          ...fs,
          stat: (target) => {
            counter.stat += 1;
            return fs.stat(target);
          },
          readDirectory: (target, options) => {
            counter.reads.set(target, (counter.reads.get(target) ?? 0) + 1);
            return fs.readDirectory(target, options);
          },
        });
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));

  const serialReference = (env: Record<string, string>) =>
    Effect.gen(function* () {
      const available: Array<string> = [];
      for (const editorId of REMOTE_CAPABLE_EDITOR_IDS) {
        const editor = EDITORS.find((candidate) => candidate.id === editorId);
        if (editor && Option.isSome(yield* resolveEditorCommand(editor, env))) {
          available.push(editorId);
        }
      }
      return available;
    });

  it.effect("reads each PATH directory once instead of stat-ing every candidate per editor", () =>
    Effect.gen(function* () {
      const { env: baseEnv } = yield* makeFakePath();
      const delimiter = platform === "win32" ? ";" : ":";
      const uncachedCounter = { stat: 0, reads: new Map<string, number>() };
      const cachedCounter = { stat: 0, reads: new Map<string, number>() };
      const uncachedEnv = { ...baseEnv, PATH: `${baseEnv.PATH}${delimiter}${baseEnv.HOME}x1` };
      const cachedEnv = { ...baseEnv, PATH: `${baseEnv.PATH}${delimiter}${baseEnv.HOME}x2` };
      const uncached = yield* serialReference(uncachedEnv).pipe(
        Effect.provide(countingFileSystem(uncachedCounter)),
      );
      const cached = yield* probeRemoteEditors
        .handler(undefined)
        .pipe(
          Effect.provideService(HostProcess.Environment, cachedEnv),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provide(countingFileSystem(cachedCounter)),
        );
      // The host can add editors from app folders the fixture can't redirect (e.g. /Applications).
      const fixtureEditors = ["cursor", "vscode", "zed", "webstorm"];
      assert.deepStrictEqual(
        uncached.filter((id) => fixtureEditors.includes(id)),
        fixtureEditors,
      );
      assert.deepStrictEqual(cached, uncached);
      assert.isAbove(uncachedCounter.stat, 0);
      // On every platform the probe lists each PATH directory at most once. Only PATH entries count:
      // resolveEditorCommand also reads app folders such as /Applications on macOS.
      const pathReads = cachedEnv.PATH.split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => cachedCounter.reads.get(entry) ?? 0);
      assert.isAbove(Math.max(...pathReads), 0);
      assert.isAtMost(Math.max(...pathReads), 1);
      // Without the listings, Windows stats every PATH entry x PATHEXT candidate for each editor;
      // elsewhere there is no PATHEXT, so the stat count is about the same either way.
      if (platform === "win32") {
        assert.isBelow(cachedCounter.stat, uncachedCounter.stat / 2);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
