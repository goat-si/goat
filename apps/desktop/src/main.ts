// GOAT 2 Electron shell: thin. It owns windows and the in-app browser (browser use, passkeys,
// cookie import, element picking need Electron), and nothing else. The engine host runs as a
// separate process so agent runs survive an app restart. Computer use stays in a signed helper app.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const WEB_URL = process.env.GOAT2_WEB_URL ?? "http://127.0.0.1:5733";
let server: ChildProcess | null = null;

function startServer(): void {
  const entry = fileURLToPath(new URL("../../server/src/main.ts", import.meta.url));
  // detached: the engine keeps running if the shell quits; a supervisor can reattach later (TODO).
  server = spawn(process.execPath.includes("Electron") ? "node" : process.execPath, [entry], {
    stdio: "inherit",
    detached: true,
  });
  server.unref();
}

function createWindow(): void {
  const win = new BrowserWindow({ width: 1440, height: 900, title: "GOAT 2" });
  void win.loadURL(WEB_URL);
}

void app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
