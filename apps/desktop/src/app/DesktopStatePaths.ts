import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { LEGACY_HOME_DIR_NAME } from "@goat/contracts/legacyT3Names";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export type JoinPath = (first: string, ...segments: string[]) => string;

/** Packaged stable keeps the location every earlier build used, so rollback finds it. */
export const STABLE_DESKTOP_HOME_DIR_NAME = "desktop";
/**
 * Nightly (and preview) builds run beside stable with their own bundled server, so they need their
 * own database, secrets and settings; DesktopChannelStateMigration seeds this from stable once.
 */
export const NIGHTLY_DESKTOP_HOME_DIR_NAME = "desktop-nightly";

function normalizeConfiguredBaseDir(goatHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(goatHome)) {
    return Option.none();
  }
  const trimmed = goatHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

// Resolve symlinks through the nearest existing ancestor, since the home may
// not exist yet; a link into ~/.goat must not pass as isolated.
const canonicalPath = Effect.fnUntraced(function* (path: Path.Path, raw: string) {
  const fs = yield* FileSystem.FileSystem;
  const missing: Array<string> = [];
  for (let current = path.resolve(raw); ; current = path.dirname(current)) {
    const real = yield* fs.realPath(current).pipe(Effect.option);
    if (Option.isSome(real)) return path.join(real.value, ...missing.toReversed());
    if (path.dirname(current) === current) return path.resolve(raw);
    missing.push(path.basename(current));
  }
});

/**
 * True only for an absolute base dir outside the home directory's own
 * `.goat` and `.t3` trees. Paths compare case-insensitively where the default
 * filesystem does, so `~/.GOAT` cannot reach the live home.
 */
export const isIsolatedDesktopBaseDir = Effect.fnUntraced(function* (input: {
  readonly homeDirectory: string;
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
}) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.baseDir)) return false;
  const fold = (value: string) =>
    input.platform === "darwin" || input.platform === "win32" ? value.toLowerCase() : value;
  const baseDir = fold(yield* canonicalPath(path, input.baseDir));
  if (baseDir === fold(yield* canonicalPath(path, input.homeDirectory))) return false;
  for (const dirName of [GOAT_HOME_DIR_NAME, LEGACY_HOME_DIR_NAME]) {
    const root = fold(yield* canonicalPath(path, path.join(input.homeDirectory, dirName)));
    if (baseDir === root || baseDir.startsWith(`${root}${path.sep}`)) return false;
  }
  return true;
});

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly goatHome: Option.Option<string>;
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  /** Lets a dev build keep a dev state left in the legacy home (see resolveGoatHome). */
  readonly pathExists?: (path: string) => boolean;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.goatHome), () => {
    if (!input.isDevelopment) {
      return input.joinPath(
        input.homeDirectory,
        GOAT_HOME_DIR_NAME,
        isNightlyDesktopVersion(input.appVersion)
          ? NIGHTLY_DESKTOP_HOME_DIR_NAME
          : STABLE_DESKTOP_HOME_DIR_NAME,
      );
    }
    // The dev runner passes its home explicitly; this is a hand-launched dev build.
    const goatHome = input.joinPath(input.homeDirectory, GOAT_HOME_DIR_NAME);
    const legacyHome = input.joinPath(input.homeDirectory, LEGACY_HOME_DIR_NAME);
    const exists = input.pathExists ?? (() => false);
    return !exists(input.joinPath(goatHome, "dev")) && exists(input.joinPath(legacyHome, "dev"))
      ? legacyHome
      : goatHome;
  });
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly goatHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.goatHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
