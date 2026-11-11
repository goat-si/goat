import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as DesktopWindowMaterial from "./material/DesktopWindowMaterial.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerDesktopClientSettings = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
  get: Effect.succeedNone,
});

const layerElectronApp = Layer.mock(ElectronApp.ElectronApp)({
  quit: Effect.void,
});

const layerDesktopAssets = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const layerDesktopServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerElectronMenu = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeedNone,
} satisfies ElectronMenu.ElectronMenu["Service"]);

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  accessibility: Effect.succeed({ reducedTransparency: false, highContrast: false }),
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const layerDesktopEnvironment = DesktopEnvironment.layer(environmentInput).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        GOAT_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

const desktopWindowBoundsEquivalence = Schema.toEquivalence(
  DesktopAppSettings.DesktopWindowBoundsSchema,
);

export function layerTest(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly mainWindowBoundsUpdates?: DesktopAppSettings.DesktopWindowBounds[];
  readonly mainWindowMaximizedUpdates?: boolean[];
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly setPreviewMainWindow?: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly destroyAll?: Effect.Effect<void>;
  readonly onWindowCreate?: Effect.Effect<void>;
  readonly openedExternalUrls?: unknown[];
  readonly onCopyText?: (text: string) => Effect.Effect<void>;
  readonly onPopupTemplate?: (input: ElectronMenu.ElectronMenuTemplateInput) => Effect.Effect<void>;
  readonly previewZoomReapplies?: number[];
  readonly onReveal?: (window: Electron.BrowserWindow) => void;
  readonly focusedWindow?: Electron.BrowserWindow;
  readonly materialWindowOptions?: { readonly transparent?: true };
  readonly materialAttachOptions?: unknown[];
}) {
  let desktopSettings = input.desktopSettings ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  const layerDesktopAppSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => desktopSettings),
    load: Effect.sync(() => desktopSettings),
    setPreviewSessionStackPoppedOut: () => Effect.die("unexpected stack popout preference change"),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        if (input.beforeMainWindowBoundsUpdate) {
          yield* input.beforeMainWindowBoundsUpdate(bounds);
        }
        const changed =
          desktopSettings.mainWindowBounds === null ||
          !desktopWindowBoundsEquivalence(desktopSettings.mainWindowBounds, bounds) ||
          desktopSettings.mainWindowMaximized !== isMaximized;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: isMaximized,
          };
          input.mainWindowBoundsUpdates?.push(bounds);
          input.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: desktopSettings, changed };
      }),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateInstallPolicy: () => Effect.die("unexpected update policy change"),
    setPendingUpdate: () => Effect.die("unexpected pending update change"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
    setHeadlessServerAttachEnabled: () => Effect.die("unexpected headless server toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const layerElectronWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        input.createdWindowOptions?.push(options);
      }).pipe(
        Effect.andThen(Ref.update(input.createCount, (count) => count + 1)),
        Effect.andThen(input.onWindowCreate ?? Effect.void),
        Effect.as(input.window),
      ),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst:
      input.focusedWindow === undefined
        ? Ref.get(input.mainWindow)
        : Effect.succeedSome(input.focusedWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    prepareReveal: () => Effect.succeed(false),
    reveal: (window) => Effect.sync(() => input.onReveal?.(window)),
    sendAll: () => Effect.void,
    destroyAll: input.destroyAll ?? Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(DesktopWindowMaterial.DesktopWindowMaterial)({
          windowOptions: Effect.succeed(input.materialWindowOptions ?? {}),
          attach: (_window, options) =>
            Effect.sync(() => {
              input.materialAttachOptions?.push(options);
            }),
          afterReveal: () => Effect.void,
          syncAppearance: () => Effect.void,
        }),
        layerDesktopAssets,
        Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
          register: () => Effect.void,
          recordMetrics: () => Effect.void,
          shutdown: Effect.void,
        }),
        layerDesktopEnvironment,
        layerDesktopAppSettings,
        layerDesktopClientSettings,
        layerDesktopServerExposure,
        DesktopState.layer,
        layerElectronApp,
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          showContextMenu: () => Effect.succeedNone,
          popupTemplate: input.onPopupTemplate ?? (() => Effect.void),
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          openSystemSettings: () => Effect.succeed(true),
          copyText: input.onCopyText ?? (() => Effect.void),
        } satisfies ElectronShell.ElectronShell["Service"]),
        layerElectronTheme,
        layerElectronWindow,
        Layer.mock(PreviewPasskeys.PreviewPasskeys)({
          bridgeEnabled: false,
          installSessionHandlers: () => {},
          attachGuest: () => () => {},
        }),
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: input.setPreviewMainWindow ?? (() => Effect.void),
          prepareWebview: () => Effect.void,
          isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"), // goat-rename: legacy
          getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"), // goat-rename: legacy
          reapplyZoom: () =>
            Effect.sync(() => {
              input.previewZoomReapplies?.push(input.window.webContents.getZoomLevel());
            }),
        }),
      ),
    ),
    Layer.merge(DesktopState.layer),
  );
}

export const makeSplashScenario = (createOutcomes: readonly (Electron.BrowserWindow | null)[]) =>
  Effect.gen(function* () {
    const createdWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const createCalls = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const revealedWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const fallbackWindow = createOutcomes.find(
      (window): window is Electron.BrowserWindow => window !== null,
    );

    const currentMainOrFirst = Effect.gen(function* () {
      const registered = yield* Ref.get(mainWindow);
      if (Option.isSome(registered)) {
        return registered;
      }
      const created = yield* Ref.get(createdWindows);
      return Option.fromNullishOr(created[0] ?? null);
    });

    const electronWindowShape = {
      create: () =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(createCalls, (count) => count + 1);
          const outcome = createOutcomes[index] ?? null;
          if (outcome === null) {
            return yield* new ElectronWindow.ElectronWindowCreateError({
              options: {
                title: null,
                width: null,
                height: null,
                minWidth: null,
                minHeight: null,
                show: null,
                modal: null,
                frame: null,
                transparent: null,
                backgroundColor: null,
                webPreferences: {
                  preload: null,
                  partition: null,
                  backgroundThrottling: null,
                  sandbox: null,
                  contextIsolation: null,
                  nodeIntegration: null,
                  webviewTag: null,
                },
              },
              cause: new Error("simulated window-open failure"),
            });
          }
          yield* Ref.update(createdWindows, (windows) => [...windows, outcome]);
          return outcome;
        }),
      main: Ref.get(mainWindow),
      currentMainOrFirst,
      focusedMainOrFirst: currentMainOrFirst,
      setMain: (window) => Ref.set(mainWindow, Option.some(window)),
      clearMain: () => Ref.set(mainWindow, Option.none()),
      prepareReveal: () => Effect.succeed(false),
      reveal: (window) => Ref.update(revealedWindows, (windows) => [...windows, window]),
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: (sync) => (fallbackWindow ? sync(fallbackWindow) : Effect.void),
    } satisfies ElectronWindow.ElectronWindow["Service"];

    const layer = DesktopWindow.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(DesktopWindowMaterial.DesktopWindowMaterial)({
            windowOptions: Effect.succeed({}),
            attach: () => Effect.void,
            afterReveal: () => Effect.void,
            syncAppearance: () => Effect.void,
          }),
          layerDesktopAssets,
          Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
            register: () => Effect.void,
            recordMetrics: () => Effect.void,
            shutdown: Effect.void,
          }),
          layerDesktopEnvironment,
          DesktopAppSettings.layerTest(),
          layerDesktopClientSettings,
          layerDesktopServerExposure,
          DesktopState.layer,
          layerElectronApp,
          layerElectronMenu,
          Layer.succeed(ElectronShell.ElectronShell, {
            openExternal: () => Effect.succeed(true),
            openSystemSettings: () => Effect.succeed(true),
            copyText: () => Effect.void,
          } satisfies ElectronShell.ElectronShell["Service"]),
          layerElectronTheme,
          Layer.succeed(ElectronWindow.ElectronWindow, electronWindowShape),
          Layer.mock(PreviewPasskeys.PreviewPasskeys)({
            bridgeEnabled: false,
            installSessionHandlers: () => {},
            attachGuest: () => () => {},
          }),
          Layer.mock(PreviewManager.PreviewManager)({
            getBrowserSession: () => Effect.succeed({} as Electron.Session),
            setMainWindow: () => Effect.void,
            isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"), // goat-rename: legacy
            getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"), // goat-rename: legacy
          }),
        ),
      ),
    );

    return { layer, createCalls, mainWindow, revealedWindows } as const;
  });
