import { isOwnedEnvName } from "@goat/contracts/legacyT3Names";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";

// The tmux/screen/Zellij keys name the multiplexer pane that launched the server,
// so inheriting them points multiplexer-aware tools at that unrelated pane.
const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (isOwnedEnvName(normalizedKey)) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting PHP_BINARY
// as the AppImage path). See issue #1699.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv: Record<string, string> | null | undefined,
  platform: NodeJS.Platform,
  home: string,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      const existingKey =
        platform === "win32"
          ? Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
          : undefined;
      spawnEnv[existingKey ?? key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value, home) : value;
    }
  }
  if (!spawnEnv.COLORTERM && runtimeEnv?.COLORTERM === undefined) {
    spawnEnv.COLORTERM = "truecolor";
  }
  // fish 4.1+ can wait 10s at startup for a DA1 reply before a renderer can answer.
  // Skip the query unless the user or provider already chose `query-term` or `no-query-term`.
  const fishFeaturesKey =
    platform === "win32"
      ? (Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === "fish_features") ??
        "fish_features")
      : "fish_features";
  const fishFeatures = spawnEnv[fishFeaturesKey];
  if (!fishFeatures?.includes("query-term")) {
    spawnEnv[fishFeaturesKey] = fishFeatures ? `${fishFeatures},no-query-term` : "no-query-term";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}
