// Lifted from GOAT v1 packages/shared/src/shell.ts (origin/dev 916b5ccc1b2): trimNonEmpty, readUserLoginShell,
// listLoginShellCandidates, normalizePathEntry, pathDelimiterForPlatform, normalizePathEntryForComparison,
// sanitizePathEntry, mergePathValues, verbatim.
import * as NodeOS from "node:os";

const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.trim().replace(/^"+|"+$/g, "") : value;
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = normalizePathEntry(entry, platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sanitizePathEntry(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? entry.replaceAll('"', "") : entry;
}

export function mergePathValues(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = pathDelimiterForPlatform(platform);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of [preferredPath, inheritedPath]) {
    if (!rawValue) continue;

    for (const entry of rawValue.split(delimiter)) {
      const sanitized = sanitizePathEntry(platform === "win32" ? entry.trim() : entry, platform);
      if (sanitized.length === 0) continue;

      const normalized = normalizePathEntryForComparison(sanitized, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(sanitized);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}
