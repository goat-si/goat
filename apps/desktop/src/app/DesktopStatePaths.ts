import * as Option from "effect/Option";

import { LEGACY_HOME_DIR_NAME } from "@goat/contracts/legacyT3Names";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(goatHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(goatHome)) {
    return Option.none();
  }
  const trimmed = goatHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly goatHome: Option.Option<string>;
  readonly isDevelopment: boolean;
  /** Lets a dev build keep a dev state left in the legacy home (see resolveGoatHome). */
  readonly pathExists?: (path: string) => boolean;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.goatHome), () => {
    if (!input.isDevelopment) return input.joinPath(input.homeDirectory, ".goat", "desktop");
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
