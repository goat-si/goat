import { isAbsolutePath, isWindowsAbsolutePath, resolveWorkspaceFilePath } from "@goat/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// All callers open one panel; the newest click must win across callers.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

// Repository-relative paths can repeat the project's suffix in subfolder projects.
function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

/**
 * The project search query that may find a chat file link's real file, or null when the link
 * names its file exactly. Agents often cite paths relative to a package (`cloud/http.ts`).
 */
export function workspaceLinkLookupQuery(relativePath: string, cwd: string): string | null {
  const trimmed = relativePath.trim();
  if (isAbsolutePath(trimmed) || /^(?:\.{1,2}|~)[\\/]/.test(trimmed) || /[\\/]$/.test(trimmed)) {
    return null;
  }
  if (needsWorkspaceBasenameLookup(trimmed)) return trimmed;
  return stripRepeatedWorkspacePrefix(trimmed, cwd) ?? trimmed;
}

/** The one file a chat link names: its basename, its path past a repeated prefix, or its suffix. */
export function pickWorkspaceLinkMatch(
  relativePath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const trimmed = relativePath.trim();
  if (needsWorkspaceBasenameLookup(trimmed)) return pickWorkspaceBasenameMatch(trimmed, entries);
  const matches = workspaceQualifiedPathMatches(trimmed, cwd, entries);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function workspaceQualifiedPathMatches(
  relativePath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): ReadonlyArray<string> {
  const stripped = stripRepeatedWorkspacePrefix(relativePath, cwd);
  const strippedMatch =
    stripped === null ? null : pickStrippedWorkspaceMatch(stripped, cwd, entries);
  if (strippedMatch !== null) return [strippedMatch];
  const suffix = relativePath.replaceAll("\\", "/");
  return entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];
    const path = entry.path.replaceAll("\\", "/");
    return path === suffix || path.endsWith(`/${suffix}`) ? [entry.path] : [];
  });
}

function pickStrippedWorkspaceMatch(
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  const key = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const files = entries.filter((entry) => entry.kind === "file");
  return files.find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}

/**
 * The absolute path of the one file a chat link names across project roots, or null when
 * no root has it or roots name different files. Agents cite paths relative to their repo.
 * Nested project roots list the same file more than once, which still names one file.
 */
export function pickProjectLinkMatch(
  relativePath: string,
  searches: ReadonlyArray<{
    readonly root: string;
    readonly entries: ReadonlyArray<WorkspaceEntryCandidate>;
  }>,
): string | null {
  const target = relativePath.trim();
  const isBasename = needsWorkspaceBasenameLookup(target);
  const folded = target.toLowerCase();
  const isFoldedMatch = (entry: WorkspaceEntryCandidate) =>
    entry.kind === "file" && basenameOfPath(entry.path).toLowerCase() === folded;
  const matches = new Map<string, string>();
  let rootHits = 0;
  const addMatch = (path: string) => {
    // Windows paths that differ only by case stay distinct: a directory can be case-sensitive.
    const key = isWindowsAbsolutePath(path) ? path.replaceAll("/", "\\") : path;
    if (!matches.has(key)) matches.set(key, path);
  };
  for (const { root, entries } of searches) {
    if (isBasename) {
      if (!entries.some(isFoldedMatch)) continue;
      rootHits += 1;
      const match = pickWorkspaceBasenameMatch(target, entries);
      if (match !== null) addMatch(resolveWorkspaceFilePath(match, root));
    } else {
      for (const match of workspaceQualifiedPathMatches(target, root, entries)) {
        addMatch(resolveWorkspaceFilePath(match, root));
      }
    }
  }
  if (isBasename && rootHits > 1) {
    // A root's pick, or a root left ambiguous by case, can hide another file elsewhere.
    for (const { root, entries } of searches) {
      for (const entry of entries) {
        if (isFoldedMatch(entry)) addMatch(resolveWorkspaceFilePath(entry.path, root));
      }
    }
  }
  return matches.size === 1 ? ([...matches.values()][0] ?? null) : null;
}
