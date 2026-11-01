/**
 * Builds the git-style patch of one edit, so a client can show what that tool call changed,
 * mid-turn and apart from other edits to the same file. Clients parse it with the same parser
 * as checkpoint diffs, so every file gets a `diff --git` header.
 *
 * Providers report absolute host paths. Prefixing those with `a/` yields `a//abs/path`, which
 * `git apply` from the project root will not take. Paths inside the thread workspace become
 * repo-relative; a file outside it keeps its absolute path.
 */
import { workspaceRelativeFilePath } from "@goat/shared/path";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;

// Git C-quotes a path holding a control character, a quote or a backslash; the parser decodes it.
function quotePath(path: string): string {
  let quoted = "";
  let needsQuotes = false;
  for (const character of path) {
    const code = character.charCodeAt(0);
    const escaped =
      character === '"' || character === "\\"
        ? `\\${character}`
        : character === "\t"
          ? "\\t"
          : character === "\n"
            ? "\\n"
            : character === "\r"
              ? "\\r"
              : code < 0x20 || code === 0x7f
                ? `\\${code.toString(8).padStart(3, "0")}`
                : character;
    needsQuotes ||= escaped !== character;
    quoted += escaped;
  }
  return needsQuotes ? `"${quoted}"` : path;
}

function headerPath(prefix: "a/" | "b/", path: string): string {
  return quotePath(`${prefix}${path}`);
}

/** Repo-relative when the file is inside the thread workspace; otherwise the path as given. */
function patchPath(path: string, workspaceRoot: string | null | undefined): string {
  const relative = workspaceRelativeFilePath(path, workspaceRoot);
  return relative !== null && relative !== "." ? relative : path;
}

function contentLines(content: string, marker: "+" | "-"): string {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.split("\n").map((line) => `${marker}${line}`);
  if (!content.endsWith("\n")) lines.push("\\ No newline at end of file");
  return lines.join("\n");
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

function wholeFileSection(
  path: string,
  content: string,
  kind: "add" | "delete",
  workspaceRoot?: string | null,
): string {
  const name = patchPath(path, workspaceRoot);
  const count = lineCount(content);
  const header =
    kind === "add"
      ? ["new file mode 100644", "--- /dev/null", `+++ ${headerPath("b/", name)}`]
      : ["deleted file mode 100644", `--- ${headerPath("a/", name)}`, "+++ /dev/null"];
  const hunk =
    count === 0
      ? []
      : [
          kind === "add" ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`,
          contentLines(content, kind === "add" ? "+" : "-"),
        ];
  return [
    `diff --git ${headerPath("a/", name)} ${headerPath("b/", name)}`,
    ...header,
    ...hunk,
  ].join("\n");
}

function updateSection(
  path: string,
  hunks: string,
  oldPath = path,
  workspaceRoot?: string | null,
): string {
  const next = patchPath(path, workspaceRoot);
  const previous = patchPath(oldPath, workspaceRoot);
  const lines = [`diff --git ${headerPath("a/", previous)} ${headerPath("b/", next)}`];
  if (previous !== next) {
    // The parser keeps the old name only for a rename it recognizes by its similarity line.
    lines.push(
      `similarity index ${hunks.length === 0 ? 100 : 50}%`,
      `rename from ${quotePath(previous)}`,
      `rename to ${quotePath(next)}`,
    );
  }
  if (hunks.length > 0) {
    lines.push(`--- ${headerPath("a/", previous)}`, `+++ ${headerPath("b/", next)}`, hunks);
  }
  return lines.join("\n");
}

/** The hunks of unified diff text, dropping any file header before the first one. */
function hunksOf(diff: string): string | undefined {
  const start = diff.search(HUNK_HEADER);
  return start === -1 ? undefined : diff.slice(start).replace(/\n+$/, "");
}

/**
 * A Codex apply_patch item. Codex sends whole file content for an added or deleted file and
 * the hunks of a unified diff for an update. Undefined when an update's diff has no hunk.
 */
export function codexFileChangePatch(
  changes: ReadonlyArray<{
    readonly path: string;
    readonly diff: string;
    readonly kind:
      | { readonly type: "add" }
      | { readonly type: "delete" }
      | { readonly type: "update"; readonly move_path?: string | null | undefined };
  }>,
  workspaceRoot?: string | null,
): string | undefined {
  const sections: Array<string> = [];
  for (const change of changes) {
    switch (change.kind.type) {
      case "add":
      case "delete":
        sections.push(wholeFileSection(change.path, change.diff, change.kind.type, workspaceRoot));
        break;
      case "update": {
        const movedTo = change.kind.move_path ?? undefined;
        const hunks = change.diff.trim().length === 0 ? "" : hunksOf(change.diff);
        if (hunks === undefined) return undefined;
        if (hunks.length === 0 && movedTo === undefined) break;
        sections.push(updateSection(movedTo ?? change.path, hunks, change.path, workspaceRoot));
        break;
      }
    }
  }
  return sections.length === 0 ? undefined : `${sections.join("\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeHunk(hunk: unknown): string | undefined {
  if (!isRecord(hunk) || !Array.isArray(hunk.lines)) return undefined;
  const { oldStart, oldLines, newStart, newLines } = hunk;
  if (
    typeof oldStart !== "number" ||
    typeof oldLines !== "number" ||
    typeof newStart !== "number" ||
    typeof newLines !== "number"
  ) {
    return undefined;
  }
  const lines = hunk.lines.filter((line): line is string => typeof line === "string");
  return [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, ...lines].join("\n");
}

/**
 * A Claude Code Edit, MultiEdit, or Write result. Its structuredPatch hunks carry real line
 * numbers; a created file carries its content instead. Staged writes changed nothing.
 */
export function claudeFileChangePatch(
  path: string,
  result: unknown,
  workspaceRoot?: string | null,
): string | undefined {
  if (!isRecord(result) || result.staged === true) return undefined;
  const filePath = typeof result.filePath === "string" && result.filePath ? result.filePath : path;
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : undefined;
  if (hunks !== undefined && hunks.length > 0) {
    const rendered = hunks.map(claudeHunk);
    if (rendered.some((hunk) => hunk === undefined)) return undefined;
    return `${updateSection(filePath, rendered.join("\n"), filePath, workspaceRoot)}\n`;
  }
  if (result.type === "create" && typeof result.content === "string") {
    return `${wholeFileSection(filePath, result.content, "add", workspaceRoot)}\n`;
  }
  return undefined;
}
