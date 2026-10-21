import type { OrchestrationV2TurnItem } from "@goat/contracts";

/** Lines a file change added and removed, as shown beside an edit row. */
export interface FileChangeLineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/** Logical lines in file content; a trailing newline does not start another line. */
function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    if (index < text.length - 1) lines += 1;
  }
  return lines;
}

/**
 * Counts the added and removed lines of unified diff text, or returns undefined
 * when the text has no hunk (an error message, JSON, or plain file content).
 * Lines before the first hunk and each file's "--- "/"+++ " header pair are
 * skipped, so a multi-file patch sums all of its files.
 */
export function countUnifiedDiffLines(diff: string): FileChangeLineCounts | undefined {
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;
  let oldLinesRemaining = 0;
  let newLinesRemaining = 0;
  let start = 0;
  while (start <= diff.length) {
    const newline = diff.indexOf("\n", start);
    const end = newline === -1 ? diff.length : newline;
    const first = diff.charCodeAt(start);
    if (diff.startsWith("@@", start)) {
      sawHunk = true;
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(diff.slice(start, end));
      oldLinesRemaining = hunk ? Number(hunk[1] ?? 1) : 0;
      newLinesRemaining = hunk ? Number(hunk[2] ?? 1) : 0;
    } else if (sawHunk && first === 0x2d /* - */) {
      const isFileHeader =
        oldLinesRemaining === 0 &&
        newLinesRemaining === 0 &&
        diff.startsWith("--- ", start) &&
        newline !== -1 &&
        diff.startsWith("+++ ", newline + 1);
      if (isFileHeader) {
        // Skip the matching "+++ " line too.
        const headerEnd = diff.indexOf("\n", newline + 1);
        start = headerEnd === -1 ? diff.length + 1 : headerEnd + 1;
        continue;
      }
      deletions += 1;
      oldLinesRemaining = Math.max(0, oldLinesRemaining - 1);
    } else if (sawHunk && first === 0x2b /* + */) {
      additions += 1;
      newLinesRemaining = Math.max(0, newLinesRemaining - 1);
    } else if (sawHunk && first === 0x20 /* space */) {
      oldLinesRemaining = Math.max(0, oldLinesRemaining - 1);
      newLinesRemaining = Math.max(0, newLinesRemaining - 1);
    }
    if (newline === -1) break;
    start = end + 1;
  }
  return sawHunk ? { additions, deletions } : undefined;
}

/**
 * Totals for a Codex apply_patch item. Codex sends whole file content for an
 * added or deleted file and a unified diff for an update.
 */
export function codexFileChangeLineCounts(
  changes: ReadonlyArray<{
    readonly diff: string;
    readonly kind: { readonly type: "add" | "delete" | "update" };
  }>,
): FileChangeLineCounts | undefined {
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    switch (change.kind.type) {
      case "add":
        additions += countTextLines(change.diff);
        break;
      case "delete":
        deletions += countTextLines(change.diff);
        break;
      case "update": {
        // A pure rename has no hunks.
        if (change.diff.trim().length === 0) break;
        const counts = countUnifiedDiffLines(change.diff);
        if (counts === undefined) return undefined;
        additions += counts.additions;
        deletions += counts.deletions;
        break;
      }
    }
  }
  return { additions, deletions };
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Totals from a Claude Code Edit, MultiEdit, or Write result. Those results
 * carry structuredPatch hunks; a created file carries its content instead.
 * Staged writes changed nothing, and an empty patch on an update may mean the
 * diff timed out, so both report no counts.
 */
export function claudeFileChangeLineCounts(result: unknown): FileChangeLineCounts | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  if (record.staged === true) return undefined;
  const hunks = record.structuredPatch;
  if (!Array.isArray(hunks)) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    const lines =
      typeof hunk === "object" && hunk !== null ? (hunk as { lines?: unknown }).lines : undefined;
    if (!Array.isArray(lines)) return undefined;
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  if (hunks.length > 0) return { additions, deletions };
  if (record.type === "create" && typeof record.content === "string") {
    return { additions: countTextLines(record.content), deletions: 0 };
  }
  const gitDiff =
    typeof record.gitDiff === "object" && record.gitDiff !== null
      ? (record.gitDiff as Record<string, unknown>)
      : undefined;
  const gitAdditions = nonNegativeInt(gitDiff?.additions);
  const gitDeletions = nonNegativeInt(gitDiff?.deletions);
  return gitAdditions === undefined || gitDeletions === undefined
    ? undefined
    : { additions: gitAdditions, deletions: gitDeletions };
}

/**
 * Fills a file change's counts from its unified diff when the adapter did not
 * report them. Runs once at ingest, before storage truncates the diff and the
 * wire projection drops it, so clients only read two numbers.
 */
export function withFileChangeLineCounts(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (
    item.type !== "file_change" ||
    item.status === "failed" ||
    item.additions !== undefined ||
    item.deletions !== undefined ||
    item.diffStr === undefined
  ) {
    return item;
  }
  const counts = countUnifiedDiffLines(item.diffStr);
  return counts === undefined ? item : { ...item, ...counts };
}
