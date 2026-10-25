// @effect-diagnostics nodeBuiltinImport:off -- a digest binds what a person approved.
import * as NodeCrypto from "node:crypto";

/**
 * Pure rules of the storage scan and cleanup: what counts as inside a GOAT folder, which temp
 * folders GOAT may remove, and the identity token a confirmation binds.
 *
 * @module storagePaths
 */

export interface PathRules {
  readonly sep: string;
  /** Case-insensitive volumes: Windows and the macOS default. */
  readonly foldCase: boolean;
}

export const pathRules = (platform: NodeJS.Platform, sep: string): PathRules => ({
  sep,
  foldCase: platform === "win32" || platform === "darwin",
});

const trimmed = (value: string, rules: PathRules) => {
  let result = value;
  while (result.length > 1 && result.endsWith(rules.sep) && !/^[A-Za-z]:\\$/u.test(result))
    result = result.slice(0, -1);
  return rules.foldCase ? result.toLowerCase() : result;
};

/** Whether target lies strictly below root. Both must be absolute, resolved paths. */
export function isStrictlyInside(root: string, target: string, rules: PathRules): boolean {
  const base = trimmed(root, rules);
  const candidate = trimmed(target, rules);
  const prefix = base.endsWith(rules.sep) ? base : base + rules.sep;
  return candidate !== base && candidate.startsWith(prefix);
}

export const samePath = (left: string, right: string, rules: PathRules) =>
  trimmed(left, rules) === trimmed(right, rules);

/** Equal, or one contains the other: a folder overlapping a project folder is never deleted. */
export const overlaps = (left: string, right: string, rules: PathRules) =>
  samePath(left, right, rules) ||
  isStrictlyInside(left, right, rules) ||
  isStrictlyInside(right, left, rules);

/**
 * Temp folders GOAT creates for one in-process operation and removes when it ends, so one older
 * than a day was left by a crash. Token broker sockets (goat-token-), Windows jobs (goat-job-)
 * and the detached runtime updater (goat-runtime-update-) outlive the server and are excluded.
 */
export const REMOVABLE_TEMP_PREFIXES = [
  "goat-probe-error-",
  "goat-antigravity-text-",
  "goat-antigravity-setup-",
  "goat-antigravity-validate-",
  "goat-codex-reception-home-",
  "goat-codex-reception-",
  "goat-claude-title-",
] as const;

export const TEMP_MIN_AGE_MS = 24 * 60 * 60_000;

export const isRemovableTempName = (name: string) =>
  REMOVABLE_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);

/** Rotated copies the trace and log writers leave: server.trace.ndjson.3, provider.log.1. */
export const isRotatedLogName = (name: string) => /\.(?:log|ndjson)\.\d+$/u.test(name);

/** sha256 of the parts, so a token reveals nothing and changes with any of them. */
export const identityToken = (parts: ReadonlyArray<string | number | bigint | null>) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(parts.map((part) => (typeof part === "bigint" ? String(part) : part))))
    .digest("hex")
    .slice(0, 32);

/** Where kache keeps its cache when KACHE_CACHE_DIR does not say. */
export function kacheCacheDirectory(input: {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly join: (...parts: Array<string>) => string;
}): string | null {
  const configured = input.env.KACHE_CACHE_DIR?.trim();
  if (configured) return configured;
  if (input.platform === "darwin") return input.join(input.home, "Library", "Caches", "kache");
  if (input.platform === "win32") {
    const local = input.env.LOCALAPPDATA?.trim();
    return local ? input.join(local, "kache") : null;
  }
  const xdg = input.env.XDG_CACHE_HOME?.trim();
  return input.join(xdg ? xdg : input.join(input.home, ".cache"), "kache");
}
