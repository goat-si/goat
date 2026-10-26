// Adopts legacy T3 env names before anything reads the environment.
import "@goat/contracts/adoptLegacyEnv";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createRestartController,
  devElectronBuildMessageType,
  devElectronOutputs,
  readOutputFingerprint,
} from "./dev-electron-restart.ts";
import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/electron/WindowsForegroundFocusWorker.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/snapShot/GlobalShiftShortcutWorker.cjs",
  "dist-electron/snapShot/RegionSnapShotWorker.cjs",
  "dist-electron/snapShot/SnapShotAccessibilityWorker.cjs",
  "../server/dist/bin.mjs",
];
// Started by `vp pack --watch` (scripts/dev-electron-pack.ts), the launcher hears when every
// bundle has finished building and keeps running across rebuilds. Run on its own, it watches the
// output directories instead.
const startedByPack = typeof process.send === "function";
const watchedDirectories = [
  ...(startedByPack ? [] : ["dist-electron", "dist-electron/electron", "dist-electron/snapShot"]),
  "../server/dist",
];
const watchedFiles = new Set(devElectronOutputs.map((file) => NodePath.basename(file)));
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const remoteDebuggingPort = process.env.GOAT_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line goat/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

let shuttingDown = false;
let currentApp = null;
const expectedExits = new WeakSet();
const watchers = [];
const restarts = createRestartController({
  readOutputs: () => readOutputFingerprint(desktopDir, devElectronOutputs),
  stopApp,
  startApp,
  debounceMs: restartDebounceMs,
});

// Registered before the startup wait, so a pack process that exits meanwhile never leaves an app.
process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
if (startedByPack) {
  process.once("disconnect", () => {
    void shutdown(0);
  });
}
// A launcher that crashes takes its app with it instead of leaving it running unowned.
process.once("exit", () => {
  currentApp?.kill("SIGTERM");
});

NodeChildProcess.execFileSync(
  process.execPath,
  [NodePath.join(desktopDir, "scripts/build-browser-secret.mjs")],
  { stdio: "inherit" },
);

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.GOAT_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.GOAT_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}

function killChildTreeByPid(pid, signal) {
  if (hostPlatform === "win32" || typeof pid !== "number") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  });

  currentApp = app;

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      restarts.request(true);
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      restarts.request(true);
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    app.kill("SIGTERM");
    killChildTreeByPid(app.pid, "TERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      app.kill("SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function startWatchers() {
  for (const directory of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        // Some platforms omit the name; the byte comparison decides either way.
        if (typeof filename === "string" && !watchedFiles.has(filename)) {
          return;
        }

        restarts.request();
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const watcher of watchers) {
    watcher.close();
  }

  await restarts.close();
  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

if (!shuttingDown) {
  startWatchers();
  restarts.launch();
  // Build reports from before the first launch are moot: it reads the outputs as they are now.
  if (startedByPack) {
    process.on("message", (message) => {
      if (message?.type !== devElectronBuildMessageType) return;
      if (message.state === "building") restarts.buildStarted();
      else restarts.buildFinished();
    });
  }
}
