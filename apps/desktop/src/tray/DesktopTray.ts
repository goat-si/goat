import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { SET_TRAY_MENU_CHANNEL, TRAY_ACTION_CHANNEL } from "../ipc/channels.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { menuIcon, withActivityDot, type DotColor } from "./trayIcons.ts";
import { createTrayMenuGate, menuUpdatesWhileOpen } from "./trayMenuGate.ts";
import { TrayMenuPayload } from "./trayMenuPayload.ts";
import {
  trayMenuTemplate,
  type DesktopTrayAction,
  type DesktopTrayMenu,
  type DesktopTrayThread,
} from "./trayMenu.ts";
import { createTrayPicks } from "./trayPicks.ts";
import {
  attachCloseToTray,
  openSessionWatcherBus,
  statusNotifierHostAvailable,
} from "./trayResidency.ts";

const { logWarning } = makeComponentLogger("desktop-tray");

const EMPTY_MENU: DesktopTrayMenu = { attention: [], running: [], pinned: [] };

// The Template suffix makes macOS tint the mark for the menu bar; Windows and Linux get the
// app tile, which reads on light and dark taskbars alike.
function trayIconFile(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "tray/trayTemplate.png";
  if (platform === "win32") return "tray/tray.png";
  return "tray/tray-linux.png";
}

function macOSMajor(): number {
  return Number.parseInt(process.getSystemVersion().split(".")[0] ?? "0", 10);
}

/** The menu-bar / notification-area icon listing threads the renderer reports. */
export const installDesktopTray = Effect.fn("desktop.tray.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopState = yield* DesktopState.DesktopState;
  const { platform, displayName } = environment;
  const nativeHeaders = platform === "darwin" && macOSMajor() >= 14;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  const warn = (message: string, annotations: Record<string, unknown>) =>
    void runPromise(logWarning(message, annotations));

  const iconFile = trayIconFile(platform);
  const iconPath = yield* (yield* DesktopAssets.DesktopAssets)
    .resolveResourcePath(iconFile)
    .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  if (Option.isNone(iconPath)) yield* logWarning("tray icon missing; tray disabled", { iconFile });

  const run = <E>(effect: Effect.Effect<void, E>, action: string) =>
    void runPromise(
      effect.pipe(
        Effect.catchCause((cause) => logWarning("tray action failed", { action, cause })),
      ),
    );
  // Actions wait for a renderer that has published a menu, which it does only after it listens.
  // It navigates itself, so a thread on a live remote opens while the local server is down.
  const picks = createTrayPicks<DesktopTrayAction, Electron.WebContents>(TRAY_ACTION_CHANNEL);
  // activate shows a hidden window and recreates one macOS closed; its renderer then receives this.
  const pick = (action: DesktopTrayAction, name: string) =>
    run(desktopWindow.activate.pipe(Effect.andThen(Effect.sync(() => picks.pick(action)))), name);
  const actions = {
    openApp: () => run(desktopWindow.activate, "open-app"),
    newThread: () => pick({ kind: "new-thread" }, "new-thread"),
    openThread: (thread: DesktopTrayThread) =>
      pick(
        { kind: "open-thread", environmentId: thread.environmentId, threadId: thread.threadId },
        "open-thread",
      ),
    quit: () => run(electronApp.quit, "quit"),
    stopComputerUse: (appId: string | null) =>
      run(
        Effect.sync(() => {
          picks.send({ kind: "stop-computer-use", appId });
        }),
        "stop-computer-use",
      ),
    stopAllComputerUse: () =>
      run(
        Effect.sync(() => {
          picks.send({ kind: "stop-all-computer-use" });
        }),
        "stop-all-computer-use",
      ),
  };

  let tray: Electron.Tray | null = null;
  let baseImage: Electron.NativeImage | null = null;
  let dottedImage: Electron.NativeImage | null = null;
  let dotShown = false;
  let dotWarned = false;
  const dotColor: DotColor = platform === "darwin" ? [0, 0, 0] : [0x0a, 0x9f, 0xff];
  const dotTemplate = platform === "darwin";
  const icons = new Map<string, Electron.NativeImage | undefined>();
  const icon = (dataUrl: string) => {
    if (icons.has(dataUrl)) return icons.get(dataUrl);
    const created = menuIcon(dataUrl);
    icons.set(dataUrl, created);
    return created;
  };
  const menuLifecycle = {
    show: () => {},
    hide: () => {},
  };
  const build = (menu: DesktopTrayMenu) => {
    if (tray === null || tray.isDestroyed()) return;
    const keep = new Set<string>();
    for (const target of menu.computerUse?.targets ?? []) {
      if (target.icon !== null) keep.add(target.icon);
    }
    for (const dataUrl of icons.keys()) {
      if (!keep.has(dataUrl)) icons.delete(dataUrl);
    }
    const built = Electron.Menu.buildFromTemplate(
      trayMenuTemplate({ menu, platform, appName: displayName, nativeHeaders, actions, icon }),
    );
    if (!menuUpdatesWhileOpen(platform)) {
      built.on("menu-will-show", () => {
        menuLifecycle.show();
      });
      built.on("menu-will-close", () => {
        menuLifecycle.hide();
      });
    }
    tray.setContextMenu(built);
  };
  const gate = createTrayMenuGate(EMPTY_MENU, build, menuUpdatesWhileOpen(platform));
  menuLifecycle.show = () => {
    gate.opened();
  };
  menuLifecycle.hide = () => {
    gate.closed();
  };
  const dotted = () => {
    if (dottedImage !== null) return dottedImage;
    const base = baseImage;
    if (base === null) throw new Error("tray icon missing");
    dottedImage = withActivityDot(base, dotColor, dotTemplate);
    return dottedImage;
  };
  // setImage leaves an open menu up, so the dot follows state while the gate is holding the menu.
  const syncDot = (menu: DesktopTrayMenu) => {
    const active = (menu.computerUse?.threadCount ?? 0) > 0;
    if (tray === null || tray.isDestroyed() || active === dotShown) return;
    if (active) {
      if (dotWarned) return;
      try {
        tray.setImage(dotted());
      } catch (cause) {
        dotWarned = true;
        warn("could not draw the activity dot; keeping the plain icon", { cause: String(cause) });
        return;
      }
    } else if (baseImage !== null) {
      tray.setImage(baseImage);
    }
    dotShown = active;
  };
  const showIcon = () => {
    if (tray !== null || Option.isNone(iconPath)) return;
    try {
      const image = Electron.nativeImage.createFromPath(iconPath.value);
      if (platform === "darwin") image.setTemplateImage(true);
      baseImage = image;
      dottedImage = null;
      dotShown = false;
      dotWarned = false;
      const created = new Electron.Tray(image);
      created.setToolTip(displayName);
      // A left click on a Windows notification-area icon opens nothing by default.
      if (platform === "win32") created.on("click", () => created.popUpContextMenu());
      tray = created;
      gate.reapply();
    } catch (cause) {
      warn("could not create tray; tray disabled", { cause: String(cause) });
    }
  };
  const hideIcon = () => {
    if (tray !== null && !tray.isDestroyed()) tray.destroy();
    tray = null;
  };
  yield* Effect.addFinalizer(() => Effect.sync(hideIcon));
  showIcon();

  // The lifecycle cancels the first before-quit while backends stop; only the one it lets through
  // is the real quit.
  let quitAllowed = false;
  yield* electronApp.on("before-quit", (event: Electron.Event) => {
    if (!event.defaultPrevented) quitAllowed = true;
  });
  let sessionEnding = false;
  const quitting = () => quitAllowed || runSync(Ref.get(desktopState.quitting));
  const closingWindows = new Set<number>();
  const keepWhenClosed = (window: Electron.BrowserWindow) => {
    if (platform === "darwin" || closingWindows.has(window.id)) return;
    closingWindows.add(window.id);
    window.once("closed", () => closingWindows.delete(window.id));
    window.on("session-end", () => {
      sessionEnding = true;
    });
    attachCloseToTray(window, {
      context: () => ({ platform, iconShown: tray !== null, quitting: quitting(), sessionEnding }),
      hostAvailable: () => statusNotifierHostAvailable(openSessionWatcherBus),
    });
  };

  // Rows go stale once their renderer reloads or is gone (macOS keeps running windowless).
  const listen = (contents: Electron.WebContents) => {
    if (picks.isListening(contents)) return;
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) forget();
    };
    const forget = () => {
      contents.removeListener("did-start-navigation", onNavigation);
      contents.removeListener("destroyed", forget);
      if (!picks.gone(contents)) return;
      gate.update(EMPTY_MENU);
      syncDot(EMPTY_MENU);
    };
    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", forget);
    picks.listening(contents);
  };

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_TRAY_MENU_CHANNEL,
      payload: TrayMenuPayload,
      result: Schema.Void,
      handler: (next, event) =>
        Effect.sync(() => {
          gate.update(next);
          syncDot(next);
          const sender =
            event === undefined ? undefined : Electron.webContents.fromId(event.sender.id);
          if (sender === undefined || sender.isDestroyed()) return;
          const window = Electron.BrowserWindow.fromWebContents(sender);
          if (window !== null) keepWhenClosed(window);
          listen(sender);
        }),
    }),
  );
});
