// GOAT 2 Electron shell (structure/10_processes.md): main owns windows only. It starts goat2-host
// as a separate process group, restarts it on crash, and ends it with its whole group on quit,
// because quitting the app ends the work. The renderer (apps/web) talks to the host directly over
// WebSocket; main only hands it {wsUrl, token} through the preload, never thread data.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell } from "electron";
import { HostSupervisor, type HostState } from "./hostSupervisor.ts";

const APP_NAME = "GOAT 2 (Dev)";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
// Dev build identity (structure/10_processes.md): own data dir and host port, nothing shared with GOAT v1.
const DATA_DIR = process.env.GOAT2_DATA_DIR ?? join(homedir(), ".goat2-dev");
const HOST_PORT = Number(process.env.GOAT2_HOST_PORT ?? 3873);
const HOST_TOKEN = randomBytes(32).toString("base64url");

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
    commit: git("rev-parse", "--short=11", "HEAD") || "unknown",
    branch: git("rev-parse", "--abbrev-ref", "HEAD") || "unknown",
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    builtAt: null,
  };
}

app.setName(APP_NAME);
app.setPath("userData", join(DATA_DIR, "desktop"));
protocol.registerSchemesAsPrivileged([
  { scheme: "goat2", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const build = readBuildInfo();
const versionLabel = `${build.branch} ${build.commit}${build.dirty ? "+dirty" : ""}`;
const hostBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", "goat2-host")
  : (process.env.GOAT2_HOST_BIN ?? join(REPO_ROOT, "target", "debug", "goat2-host"));
const webRoot = app.isPackaged
  ? join(app.getAppPath(), "web")
  : (process.env.GOAT2_WEB_DIST ?? join(REPO_ROOT, "apps", "web", "dist"));
const webUrl = !app.isPackaged && process.env.GOAT2_WEB_URL ? process.env.GOAT2_WEB_URL : "goat2://app/index.html";

const logsDir = join(DATA_DIR, "logs");
mkdirSync(logsDir, { recursive: true });
const desktopLog = createWriteStream(join(logsDir, "desktop.log"), { flags: "a" });
const hostLog = createWriteStream(join(logsDir, "host.log"), { flags: "a" });
const log = (line: string) => desktopLog.write(`${new Date().toISOString()} ${line}\n`);

const supervisor = new HostSupervisor({
  command: hostBinary,
  env: {
    ...process.env,
    GOAT2_DATA_DIR: DATA_DIR,
    GOAT2_HOST_PORT: String(HOST_PORT),
    GOAT2_HOST_TOKEN: HOST_TOKEN,
  },
  cwd: DATA_DIR,
  healthUrl: `http://127.0.0.1:${HOST_PORT}/health`,
  output: hostLog,
  log,
  onState: (state) => {
    updateTitles(state);
    if (state.announce !== null || state.phase === "crash-loop") loadWindows();
  },
});

const HOST_SUFFIX: Partial<Record<HostState["phase"], string>> = {
  starting: "host starting",
  restarting: "host restarting",
  "crash-loop": "host stopped",
  stopping: "quitting",
};

function windowTitle(state: HostState): string {
  const suffix = HOST_SUFFIX[state.phase];
  return [APP_NAME, versionLabel, suffix].filter(Boolean).join(" · ");
}

function updateTitles(state: HostState): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setTitle(windowTitle(state));
}

// The page loads once the host has printed its start line (so the preload can hand over wsUrl),
// or after a short wait if it never does; the title bar shows the host state either way.
const LOAD_WAIT_MS = 3_000;
const loaded = new WeakSet<BrowserWindow>();
function loadWindows(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || loaded.has(win)) continue;
    loaded.add(win);
    void win.loadURL(webUrl);
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: windowTitle(supervisor.state),
    backgroundColor: "#FFFFFF",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The page's <title> must not replace the build and host state in the title bar.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (supervisor.state.announce !== null || supervisor.state.phase === "crash-loop") loadWindows();
  else setTimeout(loadWindows, LOAD_WAIT_MS);
}

function serveWeb(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== "app") return new Response("not found", { status: 404 });
  const root = resolve(webRoot);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = resolve(root, relative);
  if (file !== root && !file.startsWith(root + sep)) return new Response("not found", { status: 404 });
  const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");
  return net.fetch(pathToFileURL(target).toString());
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Start Host", click: () => supervisor.start() },
          { label: "Open Data Folder", click: () => void shell.openPath(DATA_DIR) },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

ipcMain.on("goat2:host-info", (event) => {
  event.returnValue = { wsUrl: supervisor.state.announce?.wsUrl ?? null, token: HOST_TOKEN };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win === undefined) createWindow();
    else {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    log(`start ${APP_NAME} ${versionLabel} host=${hostBinary} port=${HOST_PORT} data=${DATA_DIR}`);
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: versionLabel,
      version: build.builtAt === null ? "unpackaged" : `built ${build.builtAt}`,
    });
    protocol.handle("goat2", serveWeb);
    buildMenu();
    supervisor.start();
    createWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Quitting ends the work: hold the quit until the host and its whole process group are gone.
let hostStopped = false;
app.on("before-quit", (event) => {
  if (hostStopped) return;
  event.preventDefault();
  if (supervisor.state.phase === "stopping") return;
  log("quit: stopping host group");
  void supervisor.stop().finally(() => {
    hostStopped = true;
    log("quit: host stopped");
    app.quit();
  });
});
// A terminal that launched the app closing (SIGHUP) quits it the same way. Only SIGKILL skips this;
// then the host sees stdin close and exits on its own (host contract).
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => app.quit());
