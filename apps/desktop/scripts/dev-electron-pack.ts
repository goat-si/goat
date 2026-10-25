// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - vp pack loads this with its config, before any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import type { PackUserConfig } from "vite-plus/pack";

import {
  devElectronBuildMessageType,
  type DevElectronBuildMessage,
} from "./dev-electron-restart.ts";

interface DevElectronLauncher {
  readonly connected: boolean;
  send(message: DevElectronBuildMessage, callback: (error: Error | null) => void): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
}

/**
 * Starts the dev launcher once and tells it when every pack config has finished building.
 *
 * tsdown runs onSuccess after each successful build of one config. A command onSuccess is
 * tree-killed and rerun on every rebuild, which took Electron with it whenever rolldown saw any
 * event, including the link-count change a pnpm hard link makes to a bundled node_modules file
 * (#1568). The launcher here outlives rebuilds and compares output bytes instead.
 */
export function createDevElectronBuildCoordinator(spawnLauncher: () => DevElectronLauncher) {
  // Configs whose rebuild has started. Every config's watcher sees the same file event within a
  // millisecond, well before any rebuild finishes, so waiting for this set to empty keeps the app
  // from relaunching between the bundles of one change. A config that fails stays here until it
  // builds again, so the app never relaunches next to a broken bundle.
  const building = new Set<number>();
  let launcher: DevElectronLauncher | null = null;

  const send = (state: DevElectronBuildMessage["state"]) => {
    if (!launcher?.connected) return;
    launcher.send({ type: devElectronBuildMessageType, state }, () => undefined);
  };

  const ensureLauncher = () => {
    if (launcher !== null) return;
    const child = spawnLauncher();
    launcher = child;
    const release = () => {
      if (launcher === child) launcher = null;
    };
    child.once("error", (error) => {
      console.error("[dev-electron] launcher failed", error);
      release();
    });
    child.once("exit", release);
  };

  return {
    buildStarted(config: number) {
      if (building.size === 0) send("building");
      building.add(config);
    },
    buildSucceeded(config: number) {
      building.delete(config);
      if (building.size > 0) return;
      ensureLauncher();
      send("idle");
    },
  };
}

const coordinatorKey = Symbol.for("goat.desktop.devElectronBuild");

function sharedCoordinator(
  desktopDir: string,
): ReturnType<typeof createDevElectronBuildCoordinator> {
  // tsdown reloads this config in the same process when it changes; the running launcher stays.
  const store = globalThis as {
    [coordinatorKey]?: ReturnType<typeof createDevElectronBuildCoordinator>;
  };
  store[coordinatorKey] ??= createDevElectronBuildCoordinator(() =>
    NodeChildProcess.spawn(
      process.execPath,
      [NodePath.join(desktopDir, "scripts/dev-electron.mjs")],
      {
        cwd: desktopDir,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      },
    ),
  );
  return store[coordinatorKey];
}

export function withDevElectronLaunch(
  desktopDir: string,
  configs: PackUserConfig[],
): PackUserConfig[] {
  const coordinator = sharedCoordinator(desktopDir);
  return configs.map((config, index) => ({
    ...config,
    plugins: [
      config.plugins,
      { name: "goat:dev-electron-build", buildStart: () => coordinator.buildStarted(index) },
    ],
    onSuccess: () => coordinator.buildSucceeded(index),
  }));
}
