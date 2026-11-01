// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The plain-Node dev launcher imports this; it has no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Every bundle the dev app loads. boot.cjs and compileCache.cjs are left out: dev launches main.cjs
// directly, and compileCache.cjs is only required by a packaged backend.
export const devElectronOutputs = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/preview-pick-preload.cjs",
  "dist-electron/preview-pip-preload.cjs",
  "dist-electron/mac-permission-preload.cjs",
  "dist-electron/electron/WindowsForegroundFocusWorker.cjs",
  "dist-electron/snapShot/GlobalShiftShortcutWorker.cjs",
  "dist-electron/snapShot/RegionSnapShotWorker.cjs",
  "dist-electron/snapShot/SnapShotAccessibilityWorker.cjs",
  "../server/dist/bin.mjs",
];

export const devElectronBuildMessageType = "goat:desktop-dev-build";

export interface DevElectronBuildMessage {
  readonly type: typeof devElectronBuildMessageType;
  readonly state: "building" | "idle";
}

/**
 * Hashes the bytes of every output, or returns null while one is missing (a build cleaned it).
 * Link counts, ctimes and other metadata do not take part, so a pnpm hard link elsewhere or a
 * rebuild that writes the same bytes leaves the fingerprint unchanged.
 */
export function readOutputFingerprint(
  baseDir: string,
  files: ReadonlyArray<string>,
): string | null {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = NodeFS.readFileSync(NodePath.resolve(baseDir, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Decides when the dev launcher relaunches Electron. A check runs after the last request settles
 * for debounceMs, and relaunches only when it is forced (Electron crashed) or when no build is in
 * flight and the outputs differ from the generation Electron was started with.
 */
export function createRestartController(options: {
  readonly readOutputs: () => string | null;
  readonly stopApp: () => Promise<void>;
  readonly startApp: () => void;
  readonly debounceMs: number;
}) {
  let launchedOutputs: string | null = null;
  let building = false;
  let forced = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue = Promise.resolve();

  const launch = () => {
    // A build that starts while the old app stops can leave this partial or null; the next idle
    // compares again, so Electron ends on the finished generation after at most one more relaunch.
    launchedOutputs = options.readOutputs();
    options.startApp();
  };

  const shouldRelaunch = (force: boolean) => {
    if (force) return true;
    if (building) return false;
    const outputs = options.readOutputs();
    return outputs !== null && outputs !== launchedOutputs;
  };

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const request = (force = false) => {
    if (closed) return;
    forced ||= force;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      const force = forced;
      forced = false;
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          if (closed || !shouldRelaunch(force)) return;
          await options.stopApp();
          if (!closed) launch();
        });
    }, options.debounceMs);
  };

  return {
    launch,
    request,
    buildStarted: () => {
      building = true;
      if (!forced) cancel();
    },
    buildFinished: () => {
      building = false;
      request();
    },
    close: () => {
      closed = true;
      cancel();
      return queue;
    },
    settled: () => queue,
  };
}
