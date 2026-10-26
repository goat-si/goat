// @effect-diagnostics nodeBuiltinImport:off -- This platform boundary asks the OS where an app lives with Node.
/**
 * Reads app icons for the computer use app catalog (appCatalog.ts). macOS names apps by bundle
 * id, so one osascript call resolves every id to its bundle path through LaunchServices
 * (NSWorkspace URLForApplicationWithBundleIdentifier); Windows and Linux ids are already
 * executable paths. Electron then renders each path's icon at 64x64.
 *
 * @module appIcons
 */
import * as NodeChildProcess from "node:child_process";

import type { AppIconReader, CatalogApp } from "./appCatalog.ts";

const ICON_SIZE = 64;
const LOOKUP_TIMEOUT_MS = 5_000;

/** Bundle ids pass as JSON text, never as script source, so no id can inject JavaScript. */
const MAC_BUNDLE_PATHS_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  const ids = JSON.parse(argv[0]);
  const out = {};
  for (const id of ids) {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
    if (!url.isNil()) out[id] = url.path.js;
  }
  return JSON.stringify(out);
}`;

function macBundlePaths(ids: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_BUNDLE_PATHS_SCRIPT, JSON.stringify(ids)],
      { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(new Map());
        try {
          const parsed: unknown = JSON.parse(stdout.trim() || "{}");
          const paths = new Map<string, string>();
          if (typeof parsed === "object" && parsed !== null)
            for (const [id, path] of Object.entries(parsed))
              if (typeof path === "string" && path.length > 0) paths.set(id, path);
          resolve(paths);
        } catch {
          resolve(new Map());
        }
      },
    );
  });
}

async function iconDataUrl(path: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const Electron = await import("electron");
  const size = { width: ICON_SIZE, height: ICON_SIZE };
  const image =
    platform === "darwin"
      ? await Electron.nativeImage.createThumbnailFromPath(path, size).catch(() => undefined)
      : await Electron.app.getFileIcon(path, { size: "normal" }).catch(() => undefined);
  if (image === undefined || image.isEmpty()) return undefined;
  return image.resize({ ...size, quality: "best" }).toDataURL();
}

export function makeAppIconReader(platform: NodeJS.Platform): AppIconReader {
  return async (apps: ReadonlyArray<CatalogApp>) => {
    const paths =
      platform === "darwin"
        ? await macBundlePaths(apps.filter((app) => !app.id.startsWith("/")).map((app) => app.id))
        : new Map<string, string>();
    const icons = new Map<string, string>();
    for (const app of apps) {
      const path =
        paths.get(app.id) ??
        app.executable ??
        (app.id.includes("/") || app.id.includes("\\") ? app.id : undefined);
      if (path === undefined) continue;
      const icon = await iconDataUrl(path, platform);
      if (icon !== undefined) icons.set(app.id, icon);
    }
    return icons;
  };
}
