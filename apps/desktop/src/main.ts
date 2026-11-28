// GOAT 2 Electron shell (structure/10_processes.md): main owns windows only. It starts goat2-host
// as a separate process group, restarts it on crash, and ends it with its whole group on quit,
// because quitting the app ends the work. The renderer (apps/web) talks to the host directly over
// WebSocket; main only hands it {wsUrl, token, build} through the preload, never thread data.
//
// Window, menu, protocol, single-instance and recovery behaviour are lifted from GOAT v1
// apps/desktop (docs/PROVENANCE.md, "apps/desktop" rows); host supervision is new (hostSupervisor.ts).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import { HostSupervisor, type HostState } from "./hostSupervisor.ts";
import {
  getDesktopScheme,
  getDesktopUrl,
  registerDesktopProtocol,
  registerDesktopSchemePrivilegesSync,
} from "./electron/ElectronProtocol.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import { DesktopShellEnvironment } from "./shell/DesktopShellEnvironment.ts";
import {
  configureApplicationMenu,
  type MainWindowContentsCommand,
  type MainWindowZoomDirection,
} from "./window/DesktopApplicationMenu.ts";
import {
  getInitialWindowBackgroundColor,
  getWindowTitleBarOptions,
  syncMacosWindowButtons,
} from "./window/DesktopWindowAppearance.ts";
import {
  MIN_MAIN_WINDOW_HEIGHT,
  MIN_MAIN_WINDOW_WIDTH,
  normalBoundsOnWindowDisplay,
  resolveInitialMainWindowBounds,
} from "./window/mainWindowPlacement.ts";
import { isSameOriginRendererNavigation } from "./window/rendererNavigation.ts";

/** Shown in the menu, About and the title bar. */
const DISPLAY_NAME = "GOAT 2 (Dev)";
// v1 DesktopAppIdentity.configure: the runtime name has no parentheses, because Electron keeps
// them in its User-Agent token, which breaks Turnstile in browser sessions.
const RUNTIME_APP_NAME = "GOAT 2 Dev";
// Part 1 ships only the Dev channel, packaged or not: renderer scheme goat2-dev, never v1's goat / goat-dev.
const IS_DEV_CHANNEL = true;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
// Dev build identity (structure/10_processes.md): own data dir and host port, nothing shared with GOAT v1.
const DATA_DIR = process.env.GOAT2_DATA_DIR ?? join(homedir(), ".goat2-dev");
const HOST_PORT = Number(process.env.GOAT2_HOST_PORT ?? 3873);
const HOST_TOKEN = randomBytes(32).toString("base64url");

// v1 DesktopWindow.ts constants.
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;
const DEVELOPMENT_LOAD_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES = new Set([-2, -7, -9, -102, -105, -106, -118]);

// v1 DesktopWindow.ts: an unpackaged dev load can fail while Vite is still starting.
function isRetryableDevelopmentRendererLoadFailure(input: {
  readonly applicationUrl: string;
  readonly errorCode: number;
  readonly isMainFrame: boolean;
  readonly validatedUrl: string;
}): boolean {
  return (
    input.isMainFrame &&
    DEVELOPMENT_RETRYABLE_LOAD_ERROR_CODES.has(input.errorCode) &&
    isSameOriginRendererNavigation({
      applicationUrl: input.applicationUrl,
      navigationUrl: input.validatedUrl,
    })
  );
}

interface BuildInfo {
  readonly commit: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly builtAt: string | null;
}

function readBuildInfo(): BuildInfo {
  const file = join(app.getAppPath(), "build-info.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as BuildInfo;
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    // v1 DesktopAppIdentity COMMIT_HASH_DISPLAY_LENGTH = 12.
    commit: git("rev-parse", "--short=12", "HEAD") || "unknown",
    branch: git("rev-parse", "--abbrev-ref", "HEAD") || "unknown",
    dirty: git("status", "--porcelain") !== "",
    builtAt: null,
  };
}

// Before ready (v1 ElectronProtocol: registerSchemesAsPrivileged must run during bootstrap).
registerDesktopSchemePrivilegesSync();
app.setName(RUNTIME_APP_NAME);
app.setPath("userData", join(DATA_DIR, "desktop"));

const build = readBuildInfo();
const versionLabel = `${build.branch} ${build.commit}${build.dirty ? "+dirty" : ""}`;
const hostBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", "goat2-host")
  : (process.env.GOAT2_HOST_BIN ?? join(REPO_ROOT, "target", "debug", "goat2-host"));
const webRoot = app.isPackaged
  ? join(app.getAppPath(), "web")
  : (process.env.GOAT2_WEB_DIST ?? join(REPO_ROOT, "apps", "web", "dist"));
const scheme = getDesktopScheme(IS_DEV_CHANNEL);
const applicationUrl =
  !app.isPackaged && process.env.GOAT2_WEB_URL ? process.env.GOAT2_WEB_URL : getDesktopUrl(IS_DEV_CHANNEL);
const windowStateFile = join(app.getPath("userData"), "window-state.json");

const logsDir = join(DATA_DIR, "logs");
mkdirSync(logsDir, { recursive: true });
const desktopLog = createWriteStream(join(logsDir, "desktop.log"), { flags: "a" });
const hostLog = createWriteStream(join(logsDir, "host.log"), { flags: "a" });
const log = (line: string) => desktopLog.write(`${new Date().toISOString()} ${line}\n`);

// The host's environment: what the app inherited (launchd's minimal one when opened from Finder) plus
// the person's login-shell PATH and friends (v1 DesktopShellEnvironment), so the host and the agent
// CLIs it starts are found. The shell environment rewrites only its own names in this object; every
// host spawn reads it, so a refresh reaches the next start.
const hostEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GOAT2_DATA_DIR: DATA_DIR,
  GOAT2_HOST_PORT: String(HOST_PORT),
  GOAT2_HOST_TOKEN: HOST_TOKEN,
};
const shellEnvironment = new DesktopShellEnvironment(process.env, {
  platform: process.platform,
  homeDirectory: homedir(),
  cacheFile: join(app.getPath("userData"), "shell-environment-cache.json"),
  log,
});

const supervisor = new HostSupervisor({
  command: hostBinary,
  env: hostEnv,
  cwd: DATA_DIR,
  healthUrl: (announce) => `http://127.0.0.1:${announce.port ?? HOST_PORT}/health`,
  output: hostLog,
  log,
  onState: (state) => {
    updateTitles(state);
    if (state.announce !== null || hostGaveUp(state)) loadWindows();
    if (state.announce !== null) reloadStaleWindows(state.announce.wsUrl);
  },
});

function hostGaveUp(state: HostState): boolean {
  return state.phase === "crash-loop" || state.phase === "exited";
}

const HOST_SUFFIX: Partial<Record<HostState["phase"], string>> = {
  starting: "host starting",
  restarting: "host restarting",
  stuck: "old host will not exit",
  "crash-loop": "host stopped",
  exited: "host not running",
  stopping: "quitting",
};

// Deliberate difference from v1 (which lets the renderer title the window after the open thread):
// the Dev build's title always carries the build and host state (lane G brief).
function windowTitle(state: HostState): string {
  const suffix = HOST_SUFFIX[state.phase];
  return [DISPLAY_NAME, versionLabel, suffix].filter(Boolean).join(" · ");
}

function updateTitles(state: HostState): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setTitle(windowTitle(state));
}

const isAppUrl = (url: string | undefined) =>
  url !== undefined && isSameOriginRendererNavigation({ applicationUrl, navigationUrl: url });

// v1 ElectronShell.parseSafeExternalUrl: only web links leave the app (editor links: no editor here yet).
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
function openExternalIfSafe(url: string): void {
  try {
    if (SAFE_WEB_PROTOCOLS.has(new URL(url).protocol)) void shell.openExternal(url);
  } catch {
    // Not a URL.
  }
}

// The page loads once the host has printed its start line (so the preload can hand over wsUrl),
// or after a short wait if it never does; the title bar shows the host state either way. A window
// that loaded without the current wsUrl reloads when the host announces it, so the preload's
// frozen {wsUrl, token} is never null or stale for long.
const LOAD_WAIT_MS = 3_000;
const loadedWith = new WeakMap<BrowserWindow, string | null>();
/** A link to the app's own origin (open-url, second instance) waiting for the window to load. */
let pendingAppUrl: string | null = null;
function loadWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || loadedWith.has(win)) continue;
    loadedWith.set(win, supervisor.state.announce?.wsUrl ?? null);
    const target = pendingAppUrl ?? applicationUrl;
    pendingAppUrl = null;
    // v1: load failures surface through did-fail-load; the promise rejection carries nothing more.
    void win.loadURL(target).catch(() => undefined);
  }
}

function reloadStaleWindows(wsUrl: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !loadedWith.has(win) || loadedWith.get(win) === wsUrl) continue;
    log(`reload window: host wsUrl ${loadedWith.get(win) ?? "none"} -> ${wsUrl}`);
    loadedWith.set(win, wsUrl);
    win.webContents.reload();
  }
}

const mainWindow = (): BrowserWindow | undefined =>
  BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());

function reveal(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** v1 DesktopWindow.zoomWindow: half-step zoom, buttons follow the scaled top bar. */
function zoomMain(direction: MainWindowZoomDirection): void {
  const win = mainWindow();
  if (win === undefined) return;
  const contents = win.webContents;
  contents.setZoomLevel(direction === "reset" ? 0 : contents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5));
  if (process.platform === "darwin") syncMacosWindowButtons(win);
}

/** v1 DesktopWindow.runMainContentsCommand: menu commands target the app, never a focused guest. */
function runMainContentsCommand(command: MainWindowContentsCommand): void {
  const contents = mainWindow()?.webContents;
  if (contents === undefined || contents.isDestroyed()) return;
  if (command === "reload") contents.reload();
  else if (command === "forceReload") contents.reloadIgnoringCache();
  else contents.toggleDevTools();
}

function displayBounds(): Electron.Rectangle[] {
  try {
    return screen.getAllDisplays().map((display) => display.bounds);
  } catch (error) {
    log(`failed to read connected displays; using defaults: ${String(error)}`);
    return [];
  }
}

function createWindow(): BrowserWindow {
  const saved = DesktopAppSettings.readMainWindowState(windowStateFile);
  const initialBounds = resolveInitialMainWindowBounds(saved.mainWindowBounds, displayBounds());
  const shouldUseDarkColors = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    ...initialBounds,
    minWidth: MIN_MAIN_WINDOW_WIDTH,
    minHeight: MIN_MAIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
    backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
    title: windowTitle(supervisor.state),
    ...getWindowTitleBarOptions(shouldUseDarkColors, process.platform),
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      // Hidden-renderer throttling stalls first paint; re-enable it after the first reveal.
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => {
    if (saved.mainWindowMaximized) win.maximize();
    reveal(win);
    win.webContents.setBackgroundThrottling(true);
  });

  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: "deny" };
  });
  // v1 DesktopWindow will-navigate guard; will-redirect added in GOAT 2 (review r1-4): only the app's
  // own pages may run here because the preload hands them the host token.
  const guard = (event: Electron.Event, url: string) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);

  // Ctrl+wheel bypasses menus.
  win.webContents.on("zoom-changed", (_event, direction) => {
    if (!win.isDestroyed()) zoomMain(direction);
  });
  // v1 DesktopWindow.ts development load retry (unpackaged only: the packaged app loads from disk).
  const isDevelopment = !app.isPackaged;
  let developmentLoadRetryIndex = 0;
  let developmentLoadRetryTimer: ReturnType<typeof setTimeout> | undefined;
  // GOAT 2 fix over v1: after a failed main-frame load Chromium commits its error page and fires
  // did-finish-load for the same URL right away (seen: did-fail-load -102, then did-finish-load
  // 5 ms later), which would cancel the retry just scheduled. Skip that one did-finish-load.
  let errorPagePending = false;
  const clearDevelopmentLoadRetry = () => {
    if (developmentLoadRetryTimer === undefined) return;
    clearTimeout(developmentLoadRetryTimer);
    developmentLoadRetryTimer = undefined;
  };
  const loadApplication = () => {
    if (win.isDestroyed()) return;
    void win.loadURL(applicationUrl).catch(() => undefined);
  };
  const scheduleDevelopmentLoadRetry = () => {
    if (developmentLoadRetryTimer !== undefined || win.isDestroyed()) return undefined;
    const retryIndex = Math.min(developmentLoadRetryIndex, DEVELOPMENT_LOAD_RETRY_DELAYS_MS.length - 1);
    const retryInMs = DEVELOPMENT_LOAD_RETRY_DELAYS_MS[retryIndex] ?? 2_000;
    developmentLoadRetryIndex += 1;
    developmentLoadRetryTimer = setTimeout(() => {
      developmentLoadRetryTimer = undefined;
      if (!win.isDestroyed()) loadApplication();
    }, retryInMs);
    return retryInMs;
  };
  win.webContents.on("did-finish-load", () => {
    if (errorPagePending) {
      errorPagePending = false;
      return;
    }
    if (isDevelopment && !isAppUrl(win.webContents.getURL())) return;
    clearDevelopmentLoadRetry();
    developmentLoadRetryIndex = 0;
    if (process.platform === "darwin") syncMacosWindowButtons(win);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 ERR_ABORTED: a newer navigation replaced this one; no error page follows.
    if (errorCode !== -3) errorPagePending = true;
    const retryInMs =
      isDevelopment &&
      isRetryableDevelopmentRendererLoadFailure({ applicationUrl, errorCode, isMainFrame, validatedUrl: validatedURL })
        ? scheduleDevelopmentLoadRetry()
        : undefined;
    log(
      `main window failed to load: ${errorCode} ${errorDescription} ${validatedURL}` +
        (retryInMs === undefined ? "" : `, retry in ${retryInMs} ms`),
    );
  });
  win.on("closed", clearDevelopmentLoadRetry);

  if (process.platform === "darwin") {
    // Mouse drivers can deliver Back/Forward as macOS swipe gestures instead of buttons.
    win.on("swipe", (_event, direction) => {
      const history = win.webContents.navigationHistory;
      if (direction === "left" && history.canGoBack()) history.goBack();
      else if (direction === "right" && history.canGoForward()) history.goForward();
    });
  }

  // v1 DesktopWindow render-process-gone: reload after a renderer crash; past 3 reloads a minute,
  // wait for the oldest to leave the window instead of giving up, so the window never stays blank.
  let rendererRecoveryTimestamps: number[] = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    const recoverable =
      details.reason === "crashed" ||
      details.reason === "oom" ||
      details.reason === "killed" ||
      details.reason === "abnormal-exit";
    const now = Date.now();
    rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
      (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
    );
    const shouldRecover = recoverable && !win.isDestroyed();
    const oldestAttempt =
      rendererRecoveryTimestamps.length >= RENDERER_RECOVERY_MAX_ATTEMPTS
        ? rendererRecoveryTimestamps[rendererRecoveryTimestamps.length - RENDERER_RECOVERY_MAX_ATTEMPTS]
        : undefined;
    const reloadInMs =
      oldestAttempt === undefined
        ? RENDERER_RECOVERY_RELOAD_DELAY_MS
        : Math.max(RENDERER_RECOVERY_RELOAD_DELAY_MS, oldestAttempt + RENDERER_RECOVERY_WINDOW_MS - now);
    log(
      `main window render process gone: ${details.reason} exit=${details.exitCode}` +
        (shouldRecover ? `, reload in ${reloadInMs} ms` : ""),
    );
    if (!shouldRecover) return;
    rendererRecoveryTimestamps.push(now + reloadInMs);
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload();
    }, reloadInMs);
  });

  // v1 persists main window bounds (debounced, flushed on close) and restores them on display changes.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = null;
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const bounds = maximized
      ? normalBoundsOnWindowDisplay(win.getNormalBounds(), win.getBounds(), displayBounds())
      : win.getBounds();
    try {
      DesktopAppSettings.writeMainWindowState(windowStateFile, {
        mainWindowBounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.max(MIN_MAIN_WINDOW_WIDTH, Math.round(bounds.width)),
          height: Math.max(MIN_MAIN_WINDOW_HEIGHT, Math.round(bounds.height)),
        },
        mainWindowMaximized: maximized,
      });
    } catch (error) {
      log(`failed to save window bounds: ${String(error)}`);
    }
  };
  const scheduleBoundsPersist = () => {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistBounds, MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS);
  };
  win.on("resize", scheduleBoundsPersist);
  win.on("move", scheduleBoundsPersist);
  win.on("maximize", scheduleBoundsPersist);
  win.on("unmaximize", scheduleBoundsPersist);
  win.on("close", persistBounds);

  if (supervisor.state.announce !== null || hostGaveUp(supervisor.state)) loadWindows();
  else setTimeout(loadWindows, LOAD_WAIT_MS);
  return win;
}

ipcMain.on("goat2:host-info", (event) => {
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null || !isAppUrl(frame.url)) {
    log(`refused host info to ${frame?.url ?? "unknown frame"}`);
    event.returnValue = { wsUrl: null, token: null, build: null };
    return;
  }
  // build: the Dev UI shows it in the top bar so the running version is unmistakable (owner 2026-11-28).
  event.returnValue = {
    wsUrl: supervisor.state.announce?.wsUrl ?? null,
    token: HOST_TOKEN,
    build: { commit: build.commit, branch: build.branch, builtAt: build.builtAt, dirty: build.dirty },
  };
});

/** v1 DesktopClerk resumeProviderAuth pattern: a link to the app's own origin opens in the main window. */
function openAppLink(url: string | undefined): boolean {
  if (url === undefined || !isAppUrl(url)) return false;
  const win = mainWindow();
  if (win === undefined || !loadedWith.has(win)) {
    pendingAppUrl = url;
    if (win === undefined && app.isReady()) createWindow();
    return true;
  }
  void win.loadURL(url).catch(() => undefined);
  reveal(win);
  return true;
}

// v1 DesktopClerk: take the single-instance lock before anything else starts, and queue
// second-instance / open-url events until the window exists (macOS hands the launching link to
// open-url before ready).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const pendingOpenUrls: string[] = [];
  let handleOpenUrl = (url: string) => {
    if (!isAppUrl(url)) return false;
    pendingOpenUrls.push(url);
    return true;
  };
  app.on("open-url", (event, url) => {
    if (handleOpenUrl(url)) event.preventDefault();
  });
  app.on("second-instance", (_event, argv) => {
    if (argv.some((value) => openAppLink(value))) return;
    const win = mainWindow();
    if (win === undefined) createWindow();
    else reveal(win);
  });

  void app.whenReady().then(() => {
    log(`start ${DISPLAY_NAME} ${versionLabel} host=${hostBinary} port=${HOST_PORT} data=${DATA_DIR}`);
    // v1 DesktopAppIdentity.configure: About shows the app version and the build commit.
    app.setAboutPanelOptions({
      applicationName: DISPLAY_NAME,
      applicationVersion: app.getVersion(),
      version: versionLabel,
    });
    registerDesktopProtocol(scheme, webRoot);
    // The last login-shell answer starts the host at once; the probe refreshes it for later starts.
    // Without one (first launch, new shell), every host start waits for the probe, the menu's Start
    // Host included: started from Finder the host would otherwise not find codex & co, and a running
    // host cannot take the answer later (review shellenv-4).
    // v1 retries a login shell that does not answer (30 s, 2 min, 10 min, review shellenv2-1); a later
    // answer reaches the next host start, and Restart Host… applies it to the running one.
    const cached = shellEnvironment.installCached(hostEnv);
    const discovery = shellEnvironment.startDiscovery(hostEnv, {
      onLateAnswer: () => {
        log("shell environment: the login shell answered on a retry; Restart Host… gives the running host its PATH");
      },
    });
    void discovery.first.then((answered) => {
      log(`shell environment: ${answered ? "login shell answered" : "login shell did not answer (retrying)"}`);
    });
    log(`shell environment: ${cached ? "cached answer applied" : "no cached answer, waiting for the login shell"}`);
    const hostEnvironmentReady: Promise<unknown> = cached ? Promise.resolve() : discovery.first;
    const startHost = () => void hostEnvironmentReady.then(() => supervisor.start());
    const restartHost = () => {
      const win = mainWindow();
      const options = {
        type: "warning" as const,
        message: "Restart the host?",
        detail: "Work that is running ends, as when the app quits.",
        buttons: ["Restart Host", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      };
      void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(({ response }) => {
        if (response === 0) void hostEnvironmentReady.then(() => supervisor.restart());
      });
    };
    configureApplicationMenu({
      displayName: DISPLAY_NAME,
      platform: process.platform,
      startHost,
      restartHost,
      zoomMain,
      runMainContentsCommand,
    });
    for (const url of pendingOpenUrls.splice(0)) pendingAppUrl = url;
    for (const value of process.argv) if (isAppUrl(value)) pendingAppUrl = value;
    handleOpenUrl = openAppLink;
    createWindow();
    startHost();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Quitting ends the work: hold the quit until the host and its whole process group are gone, and
// kill a login-shell probe still running (its deadline timer would die with the app).
let hostStopped = false;
app.on("before-quit", (event) => {
  if (hostStopped) return;
  event.preventDefault();
  if (supervisor.state.phase === "stopping") return;
  log("quit: stopping host group");
  void Promise.allSettled([supervisor.stop(), shellEnvironment.stop()]).finally(() => {
    hostStopped = true;
    log("quit: host stopped");
    app.quit();
  });
});
// A terminal that launched the app closing (SIGHUP) quits it the same way. Only SIGKILL skips this;
// then the host sees stdin close and exits on its own (host contract).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => app.quit());
