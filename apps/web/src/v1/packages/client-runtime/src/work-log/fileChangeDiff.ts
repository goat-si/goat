import type { OrchestrationV2TurnItem } from "@goat/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import { processFile } from "@pierre/diffs/utils/parsePatchFiles";

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;

/** Larger files open in the full diff view, which virtualizes; the transcript does not. */
export const INLINE_DIFF_MAX_LINES = 400;

/**
 * Rows an inline card renders. The file's own unifiedLineCount also counts the unchanged lines
 * collapsed before each hunk, so a one-line edit deep in a long file would read as huge.
 */
export function inlineDiffLineCount(file: FileDiffMetadata): number {
  return file.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0);
}

export function fileChangeTargetPaths(item: FileChangeItem): ReadonlyArray<string> {
  const paths = item.changes?.map((change) => change.path) ?? [];
  return paths.length > 0 ? [...new Set(paths)] : [item.fileName];
}

/**
 * The file's own name. Git quotes and escapes a name holding a tab, a newline, a quote or a
 * backslash, and the parser decodes it, so this is the name the host knows the file by.
 */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? "";
}

export function resolveFileDiffPreviousPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevName ?? fileDiff.name ?? "";
}

function normalizeDiffPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isAbsoluteDiffPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

/**
 * The patch file a provider-reported path names. Providers report absolute paths on the host
 * that ran the edit, while checkpoint patches are repository-relative. Inside the thread's
 * workspace the path is compared relative to it, so a reverted `src/index.ts` cannot pick a
 * changed root `index.ts`; the patch may still carry a prefix when the workspace is a
 * subdirectory of its repository. Outside it, the longest patch path the target ends with wins.
 */
export function findPatchFile<T extends FileDiffMetadata>(
  files: ReadonlyArray<T>,
  targetPath: string,
  workspaceRoot?: string | undefined,
): T | null {
  const target = normalizeDiffPath(targetPath);
  const root = workspaceRoot ? normalizeDiffPath(workspaceRoot) : null;
  const relative =
    root !== null && target.startsWith(`${root}/`)
      ? target.slice(root.length + 1)
      : isAbsoluteDiffPath(target)
        ? null
        : target;
  const matches = (candidate: string) =>
    candidate.length > 0 &&
    (relative !== null
      ? candidate === relative || candidate.endsWith(`/${relative}`)
      : target === candidate || target.endsWith(`/${candidate}`));
  let best: T | null = null;
  let bestLength = -1;
  for (const file of files) {
    for (const path of [resolveFileDiffPath(file), resolveFileDiffPreviousPath(file)]) {
      const candidate = normalizeDiffPath(path);
      // A relative match prefers the shortest prefix; a suffix match the longest patch path.
      const length = relative !== null ? -candidate.length : candidate.length;
      if ((best === null || length > bestLength) && matches(candidate)) {
        best = file;
        bestLength = length;
      }
    }
  }
  return best;
}

/**
 * The one-file section of a multi-file git patch, for copying. Each section's header goes
 * through the parser, so a name git quoted and escaped (non-ASCII, tabs, quotes) still matches.
 */
export function extractFilePatch(patch: string, file: FileDiffMetadata): string {
  const path = resolveFileDiffPath(file);
  for (const section of patch.split(/^(?=diff --git )/m)) {
    if (!section.startsWith("diff --git ")) continue;
    const firstHunk = section.search(/^@@ /m);
    const header = processFile(firstHunk === -1 ? section : section.slice(0, firstHunk), {
      isGitDiff: true,
    });
    // A hunk can end in a blank context line, a single space that trimEnd would drop.
    if (header !== undefined && resolveFileDiffPath(header) === path) {
      return section.replace(/[\r\n]+$/, "");
    }
  }
  return "";
}
