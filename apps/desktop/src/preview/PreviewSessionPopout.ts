// @effect-diagnostics nodeBuiltinImport:off -- Electron reports the OS version for capture capability.
import {
  DesktopPreviewSessionStackRequest,
  PREVIEW_SESSION_STACK_WINDOW_NAME,
  type DesktopPreviewSessionStackState,
} from "@goat/contracts";
import * as Electron from "electron";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as NodeOS from "node:os";

import { PREVIEW_SESSION_STACK_CHANNEL } from "../ipc/channels.ts";

export { PREVIEW_SESSION_STACK_WINDOW_NAME };

const WIDTH = 296;
const decodeRequest = Schema.decodeUnknownSync(DesktopPreviewSessionStackRequest);
const contains = (bounds: Electron.Rectangle, point: Electron.Point) =>
  point.x >= bounds.x &&
  point.x < bounds.x + bounds.width &&
  point.y >= bounds.y &&
  point.y < bounds.y + bounds.height;

/**
 * The renderer portals its existing React tree into the native child. Only its owner main frame
 * may change the window; the blank child never loads remote content or a second app runtime.
 */
export class PreviewSessionPopout {
  private window: Electron.BrowserWindow | undefined;
  private height = 0;
  private readonly points = new Map<string, Electron.Point>();
  private tearingDown = false;
  private pending: Promise<unknown> = Promise.resolve();
  private state: DesktopPreviewSessionStackState;

  private readonly owner: Electron.BrowserWindow;
  private readonly platform: string;
  private readonly persist: (poppedOut: boolean) => Promise<void>;
  private readonly onError: (error: unknown) => void;

  constructor(
    owner: Electron.BrowserWindow,
    platform: string,
    poppedOut: boolean,
    persist: (poppedOut: boolean) => Promise<void>,
    onError: (error: unknown) => void,
    systemVersion = NodeOS.release(),
  ) {
    this.owner = owner;
    this.platform = platform;
    this.persist = persist;
    this.onError = onError;
    // https://www.electronjs.org/docs/latest/api/browser-window#setcontentprotectionenable
    // macOS sets NSWindowSharingNone, but ScreenCaptureKit can still capture it. Windows before
    // 10 2004 (build 19041) produces a black window; exclusion takes effect on the next desktop
    // composition. Linux has no content-protection API.
    const build = Number(systemVersion.split(".")[2] ?? 0);
    this.state = {
      poppedOut,
      open: false,
      visible: false,
      maxHeight: 1,
      mouseEventForwarding: platform === "darwin" || platform === "win32",
      captureProtection:
        platform === "darwin"
          ? "macos-sharing-none"
          : platform === "win32"
            ? build >= 19041
              ? "windows-exclude-from-capture"
              : "windows-monitor-only"
            : "unsupported",
    };
    Electron.ipcMain.handle(PREVIEW_SESSION_STACK_CHANNEL, (event, raw: unknown) => {
      if (event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame)
        throw new Error("Only the stack's owning main frame may control its window.");
      const request = decodeRequest(raw);
      // Serialize persistence with native close and rapid Dock/layout requests.
      const result = this.pending.then(() => this.request(request));
      this.pending = result.catch(() => undefined);
      return result;
    });
    owner.webContents.on("did-create-window", (window, details) => {
      if (details.frameName === PREVIEW_SESSION_STACK_WINDOW_NAME) this.adopt(window);
    });
    // Only a new document tears the stack down: in-app routing (pushState, hash) fires no
    // did-finish-load, so suspending on it would leave the pop-out closed for good.
    owner.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.suspend();
    });
    owner.webContents.on("did-finish-load", () => {
      this.tearingDown = false;
    });
    owner.on("move", this.place);
    owner.on("resize", this.place);
    owner.on("close", () => this.suspend());
    owner.on("closed", () => {
      this.suspend();
      Electron.ipcMain.removeHandler(PREVIEW_SESSION_STACK_CHANNEL);
      Electron.screen.removeListener("display-metrics-changed", this.place);
      Electron.screen.removeListener("display-removed", this.place);
    });
    Electron.screen.on("display-metrics-changed", this.place);
    Electron.screen.on("display-removed", this.place);
  }

  open(details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse | undefined {
    if (details.url !== "about:blank" || details.frameName !== PREVIEW_SESSION_STACK_WINDOW_NAME)
      return undefined;
    if (this.window || this.tearingDown) return { action: "deny" };
    const area = Electron.screen.getDisplayMatching(this.owner.getBounds()).workArea;
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        x: area.x + area.width - Math.min(WIDTH, area.width),
        y: area.y,
        width: Math.min(WIDTH, area.width),
        height: 1,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        focusable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        ...(this.platform === "darwin" ? { type: "panel" } : {}),
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
      },
    };
  }

  private emit() {
    if (!this.owner.isDestroyed() && !this.owner.webContents.isDestroyed())
      this.owner.webContents.send(PREVIEW_SESSION_STACK_CHANNEL, this.state);
  }

  /**
   * Clicks pass through to the app below except on a tile. That needs the OS to forward mouse
   * movement while ignoring it (macOS, Windows); elsewhere the small stack stays clickable.
   */
  private passThrough(window: Electron.BrowserWindow) {
    if (this.state.mouseEventForwarding) window.setIgnoreMouseEvents(true, { forward: true });
  }

  private adopt(window: Electron.BrowserWindow) {
    this.window = window;
    this.state = { ...this.state, open: true };
    // macOS uses the floating level; Windows stays above normal windows. Linux depends on
    // its window manager (and cannot forward ignored mouse movement to the renderer).
    window.setAlwaysOnTop(true, "floating");
    // skipTransformProcessType keeps GOAT in the Dock; without it macOS turns the whole app
    // into a UI element when a window joins every workspace.
    if (this.platform !== "win32")
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    if (this.platform === "darwin" || this.platform === "win32") window.setContentProtection(true);
    this.passThrough(window);
    window.webContents.setZoomFactor(1);
    window.webContents.setBackgroundThrottling(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.on("show", () => this.updateVisible());
    window.on("hide", () => this.updateVisible());
    window.on("close", (event) => {
      if (this.tearingDown) return;
      event.preventDefault();
      void this.enqueueDock().catch(this.onError);
    });
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = undefined;
      this.state = { ...this.state, visible: false };
      // Closing the owner/reloading it preserves the restart preference.
      if (!this.tearingDown) void this.enqueueDock().catch(this.onError);
    });
    this.place();
  }

  private updateVisible() {
    const visible = this.window?.isVisible() ?? false;
    if (visible === this.state.visible) return;
    if (!visible) if (this.window) this.passThrough(this.window);
    this.state = { ...this.state, visible };
    this.emit();
  }

  private enqueueDock() {
    const result = this.pending.then(() => this.request({ type: "dock" }));
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async request(input: DesktopPreviewSessionStackRequest) {
    if (this.tearingDown) return this.state;
    switch (input.type) {
      case "state":
        break;
      case "dock": {
        await this.persist(false);
        this.state = { ...this.state, poppedOut: false, open: false, visible: false };
        const window = this.window;
        this.window = undefined;
        this.points.clear();
        window?.destroy();
        this.emit();
        break;
      }
      case "release":
        this.releaseWindow();
        this.emit();
        break;
      case "layout":
        if (!this.window) throw new Error("The floating stack window is not open.");
        if (!this.state.poppedOut) await this.persist(true);
        if (this.tearingDown || !this.window) return this.state;
        this.state = { ...this.state, poppedOut: true };
        this.height = Math.ceil(input.height);
        this.place();
        break;
      case "interactive":
        if (this.state.mouseEventForwarding)
          this.window?.setIgnoreMouseEvents(!input.interactive, { forward: true });
        break;
      case "pointer": {
        if (!this.window) break;
        // Desktop helper sessions currently publish no local screen coordinates. Remote browser
        // viewport coordinates are not local points either. Only a visible local hosted webview
        // is mapped by ElectronBrowserHost. Reports have no action-end signal: retain the point
        // until the next report or explicit release rather than guessing an action duration.
        if (input.point) this.points.set(input.tabId, input.point);
        else this.points.delete(input.tabId);
        this.place();
        break;
      }
    }
    return this.state;
  }

  private suspend() {
    this.tearingDown = true;
    this.releaseWindow();
    this.emit();
  }

  private releaseWindow() {
    const window = this.window;
    this.window = undefined;
    window?.destroy();
    this.height = 0;
    this.points.clear();
    this.state = { ...this.state, open: false, visible: false };
  }

  private readonly place = () => {
    const window = this.window;
    if (!window || window.isDestroyed() || this.owner.isDestroyed()) return;
    const area = Electron.screen.getDisplayMatching(this.owner.getBounds()).workArea;
    const height = Math.max(1, Math.min(this.height, area.height));
    const bounds = {
      x: area.x + area.width - Math.min(WIDTH, area.width),
      y: area.y,
      width: Math.min(WIDTH, area.width),
      height,
    };
    const origin = this.owner.getContentBounds();
    const zoom = this.owner.webContents.getZoomFactor();
    const points = [...this.points.values()].map((point) => ({
      x: origin.x + point.x * zoom,
      y: origin.y + point.y * zoom,
    }));
    if (points.some((point) => contains(bounds, point))) bounds.y = area.y + area.height - height;
    const blocked = points.some((point) => contains(bounds, point));
    window.setBounds(bounds, false);
    // Moving a hovered tile must not leave its old input region intercepting the next click.
    this.passThrough(window);
    if (this.height === 0 || blocked || !this.state.poppedOut) window.hide();
    else if (!window.isVisible()) window.showInactive();
    this.state = { ...this.state, maxHeight: area.height, visible: window.isVisible() };
    this.emit();
  };
}

export const makePreviewSessionPopoutInstaller = Effect.fn("PreviewSessionPopout.installer")(
  function* (platform: string) {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const shell = yield* ElectronShell.ElectronShell;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    return Effect.fn("PreviewSessionPopout.install")(function* (owner: Electron.BrowserWindow) {
      const persisted = yield* settings.get;
      const manager = new PreviewSessionPopout(
        owner,
        platform,
        persisted.previewSessionStackPoppedOut,
        (poppedOut) =>
          runPromise(settings.setPreviewSessionStackPoppedOut(poppedOut).pipe(Effect.asVoid)),
        (error) => {
          void runPromise(Effect.logWarning("Preview session popout failed", error));
        },
      );
      owner.webContents.setWindowOpenHandler((details) => {
        const popout = manager.open(details);
        if (popout) return popout;
        if (Option.isSome(ElectronShell.parseSafeExternalUrl(details.url)))
          void runPromise(shell.openExternal(details.url));
        return { action: "deny" };
      });
    });
  },
);
