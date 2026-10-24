import * as NodeOS from "node:os";
import {
  DEFAULT_CLIENT_SETTINGS,
  type DesktopWindowMaterialState,
  type DesktopWindowMaterialReason,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Electron from "electron";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { WINDOW_MATERIAL_STATE_CHANNEL } from "../../ipc/channels.ts";
import {
  getInitialWindowBackgroundColor,
  getWindowTitleBarOptions,
  syncWindowAppearance,
} from "../DesktopWindowAppearance.ts";
import * as Adapters from "./adapters.ts";
import { probeCapability, resolveWindowMaterial } from "./materialPolicy.ts";

export class WindowMaterialSenderError extends Schema.TaggedError<WindowMaterialSenderError>()(
  "WindowMaterialSenderError",
  { senderId: Schema.Number },
) {}

export class DesktopWindowMaterial extends Context.Service<
  DesktopWindowMaterial,
  {
    readonly attach: (window: Electron.BrowserWindow) => Effect.Effect<void, never, Scope.Scope>;
    readonly afterReveal: (window: Electron.BrowserWindow) => Effect.Effect<void>;
    readonly syncAppearance: (window: Electron.BrowserWindow, dark: boolean) => Effect.Effect<void>;
    readonly getState: (
      senderWebContentsId: number,
    ) => Effect.Effect<DesktopWindowMaterialState, WindowMaterialSenderError>;
  }
>()("@goat/desktop/window/material/DesktopWindowMaterial") {}

type WindowRecord = {
  readonly window: Electron.BrowserWindow;
  readonly semaphore: Semaphore.Semaphore;
  readonly removeListeners: () => void;
  state: DesktopWindowMaterialState;
  generation: number;
  revealed: boolean;
  closing: boolean;
  closed: boolean;
  attachment: ReturnType<Adapters.MaterialAdapter["attachSync"]> | undefined;
};

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const theme = yield* ElectronTheme.ElectronTheme;
  const settingsStore = yield* DesktopClientSettings.DesktopClientSettings;
  const adapter = yield* Adapters.WindowMaterialAdapter;
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const windows = new Map<number, WindowRecord>();
  const capability = probeCapability({
    platform: environment.platform,
    macOSMajor: null,
    windowsBuild: Number(NodeOS.release().split(".")[2]) || null,
    hasBackgroundMaterialApi:
      typeof Electron.BrowserWindow?.prototype?.setBackgroundMaterial === "function",
  });
  let settings = DEFAULT_CLIENT_SETTINGS;
  let settingsRevision = 0;
  let dark = yield* theme.shouldUseDarkColors;
  let accessibility = yield* theme.accessibility;

  const policy = (entry: WindowRecord) =>
    resolveWindowMaterial({
      capability,
      enabled: settings.desktopSystemMaterialEnabled,
      glassOpacity: settings.glassOpacity,
      ...accessibility,
      revealed: entry.revealed && !entry.closing,
      fullscreen: entry.window.isFullScreen(),
    });

  const publish = (entry: WindowRecord, reason: DesktopWindowMaterialReason) => {
    const applied = reason === "active" ? adapter.kind : ("none" as const);
    const next = {
      capability,
      enabled: settings.desktopSystemMaterialEnabled,
      ...accessibility,
      applied,
      reason,
    };
    const previous = entry.state;
    if (
      previous.reason === reason &&
      previous.applied === applied &&
      previous.enabled === next.enabled &&
      previous.reducedTransparency === next.reducedTransparency &&
      previous.highContrast === next.highContrast
    )
      return;
    entry.state = { ...next, revision: previous.revision + 1 };
    if (!entry.window.webContents.isDestroyed())
      entry.window.webContents.send(WINDOW_MATERIAL_STATE_CHANNEL, entry.state);
  };

  const updateOverlay = (entry: WindowRecord, active: boolean) => {
    const { titleBarOverlay } = getWindowTitleBarOptions(dark, environment.platform);
    if (typeof titleBarOverlay === "object")
      entry.window.setTitleBarOverlay({
        ...titleBarOverlay,
        ...(environment.platform === "win32" && active ? { color: "#00000000" } : {}),
      });
  };

  const disableSync = (entry: WindowRecord, reason: DesktopWindowMaterialReason) => {
    if (entry.closed || entry.window.isDestroyed()) return;
    entry.window.setBackgroundColor(getInitialWindowBackgroundColor(dark));
    updateOverlay(entry, false);
    try {
      publish(entry, reason);
    } finally {
      // Release while Electron's native handle is still valid, including on close.
      entry.attachment?.releaseSync();
      entry.attachment = undefined;
    }
  };

  const reconcile = Effect.fn("desktop.windowMaterial.reconcile")(function* (
    entry: WindowRecord,
    generation: number,
  ) {
    if (entry.closed || entry.window.isDestroyed() || generation !== entry.generation) return;
    const desired = policy(entry);
    if (desired.applied === "none") {
      disableSync(entry, desired.reason);
      return;
    }
    if (entry.attachment === undefined) {
      const prepared = yield* adapter.prepare().pipe(Effect.result);
      if (
        entry.closed ||
        entry.window.isDestroyed() ||
        generation !== entry.generation ||
        policy(entry).applied === "none"
      )
        return;
      if (prepared._tag === "Failure") {
        disableSync(entry, "native-failed");
        return;
      }
      try {
        entry.attachment = adapter.attachSync(entry.window);
        entry.window.setBackgroundColor("#00000000");
        updateOverlay(entry, true);
        publish(entry, "active");
      } catch (cause) {
        disableSync(entry, "native-failed");
        yield* Effect.logWarning("Could not attach desktop window material.", cause);
      }
    } else {
      entry.window.setBackgroundColor("#00000000");
      updateOverlay(entry, true);
      publish(entry, "active");
    }
  });

  const request = (entry: WindowRecord) => {
    const generation = ++entry.generation;
    if (entry.closed || entry.window.isDestroyed()) return Effect.void;
    const desired = policy(entry);
    if (desired.applied === "none") disableSync(entry, desired.reason);
    return reconcile(entry, generation).pipe(entry.semaphore.withPermits(1));
  };
  const schedule = (effect: Effect.Effect<void>) => {
    runFork(
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Desktop material reconciliation failed.", cause),
        ),
        Effect.forkIn(scope),
      ),
    );
  };

  const detach = Effect.fn("desktop.windowMaterial.detach")((senderId: number) =>
    Effect.sync(() => {
      const entry = windows.get(senderId);
      if (entry === undefined) return;
      entry.generation++;
      disableSync(entry, "unrevealed");
      entry.closed = true;
      windows.delete(senderId);
      entry.removeListeners();
    }),
  );

  yield* settingsStore.onCommitted((committed) => {
    settingsRevision++;
    const changed =
      committed.desktopSystemMaterialEnabled !== settings.desktopSystemMaterialEnabled ||
      committed.glassOpacity !== settings.glassOpacity;
    settings = committed;
    if (changed) for (const entry of windows.values()) schedule(request(entry));
  });
  yield* theme.onUpdated(() =>
    schedule(
      Effect.gen(function* () {
        dark = yield* theme.shouldUseDarkColors;
        accessibility = yield* theme.accessibility;
        for (const entry of windows.values()) yield* request(entry);
      }),
    ),
  );
  const startupRevision = settingsRevision;
  const initial = yield* settingsStore.get.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not load material preferences.", cause).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  if (startupRevision === settingsRevision && Option.isSome(initial)) settings = initial.value;

  return DesktopWindowMaterial.of({
    attach: Effect.fn("desktop.windowMaterial.attach")(function* (window) {
      if (window.isDestroyed()) return;
      if (windows.has(window.webContents.id)) return;
      const semaphore = yield* Semaphore.make(1);
      const senderId = window.webContents.id;
      const onFullscreen = () => schedule(request(entry));
      const onClose = (event: Electron.Event) => {
        entry.closing = true;
        entry.generation++;
        disableSync(entry, "unrevealed");
        // Electron finishes dispatching close before this microtask observes preventDefault.
        queueMicrotask(() => {
          if (event.defaultPrevented && !entry.closed && !window.isDestroyed()) {
            entry.closing = false;
            schedule(request(entry));
          }
        });
      };
      const onClosed = () => {
        entry.closed = true;
        entry.generation++;
        entry.attachment = undefined;
        windows.delete(senderId);
        entry.removeListeners();
      };
      const entry: WindowRecord = {
        window,
        semaphore,
        generation: 0,
        revealed: false,
        closing: false,
        closed: false,
        attachment: undefined,
        state: {
          revision: 0,
          capability,
          enabled: settings.desktopSystemMaterialEnabled,
          ...accessibility,
          applied: "none",
          reason: "unrevealed",
        },
        removeListeners: () => {
          window.removeListener("enter-full-screen", onFullscreen);
          window.removeListener("leave-full-screen", onFullscreen);
          window.removeListener("close", onClose);
          window.removeListener("closed", onClosed);
        },
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          windows.set(senderId, entry);
          window.on("enter-full-screen", onFullscreen);
          window.on("leave-full-screen", onFullscreen);
          window.on("close", onClose);
          window.on("closed", onClosed);
          return senderId;
        }),
        detach,
      );
      yield* request(entry);
    }),
    afterReveal: Effect.fn("desktop.windowMaterial.afterReveal")(function* (window) {
      if (window.isDestroyed()) return;
      const entry = windows.get(window.webContents.id);
      if (entry === undefined || entry.closed) return;
      entry.revealed = true;
      yield* request(entry);
    }),
    syncAppearance: Effect.fn("desktop.windowMaterial.syncAppearance")(
      function* (window, shouldUseDarkColors) {
        if (window.isDestroyed()) return;
        dark = shouldUseDarkColors;
        const entry = windows.get(window.webContents.id);
        yield* syncWindowAppearance(
          window,
          dark,
          environment.platform,
          entry?.attachment !== undefined,
        );
      },
    ),
    getState: Effect.fn("desktop.windowMaterial.getState")(function* (senderId) {
      const entry = windows.get(senderId);
      if (entry === undefined || entry.closed || entry.window.isDestroyed())
        return yield* new WindowMaterialSenderError({ senderId });
      return entry.state;
    }),
  });
});

export const layer = Layer.effect(DesktopWindowMaterial, make);
