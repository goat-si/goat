import { cutLineNote } from "@goat/shared/diffCutLines";
import { unquoteGitPatchPath } from "@goat/shared/gitPatchPath";

const ENTRY = "diff --git ";
const QUOTE = '"';

interface Entry {
  oldPath: string | null;
  newPath: string | null;
  deleted: boolean;
  revision: string | null;
  /** After the first hunk, content can resemble file headers. */
  inBody: boolean;
}

function quotedEnd(rest: string): number {
  for (let at = 1; at < rest.length; at += 1) {
    const char = rest.charAt(at);
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (char === QUOTE) return at;
  }
  return -1;
}

/** Git terminates names with a literal tab and escapes tabs within names. */
function sidePath(rest: string, prefix: string): string | null {
  const tab = rest.indexOf("\t");
  const token = tab === -1 ? rest : rest.slice(0, tab);
  if (token === "/dev/null") return null;
  const path = unquoteGitPatchPath(token);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function headerSide(token: string, prefix: string): string | null {
  const path = unquoteGitPatchPath(token);
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** Match equal sides for ambiguous unquoted paths; renames state paths separately. */
function headerPaths(rest: string): readonly [string | null, string | null] {
  if (rest.startsWith(QUOTE)) {
    const end = quotedEnd(rest);
    if (end === -1 || rest.charAt(end + 1) !== " ") return [null, null];
    return [headerSide(rest.slice(0, end + 1), "a/"), headerSide(rest.slice(end + 2), "b/")];
  }
  if (rest.endsWith(QUOTE)) {
    const opens = rest.indexOf(QUOTE);
    if (opens < 1 || rest.charAt(opens - 1) !== " ") return [null, null];
    return [headerSide(rest.slice(0, opens - 1), "a/"), headerSide(rest.slice(opens), "b/")];
  }
  if (!rest.startsWith("a/")) return [null, null];
  const splits: Array<number> = [];
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) splits.push(at);
  const chosen =
    splits.find((at) => rest.slice(2, at) === rest.slice(at + 3)) ??
    (splits.length === 1 ? splits[0] : undefined);
  return chosen === undefined ? [null, null] : [rest.slice(2, chosen), rest.slice(chosen + 3)];
}

function headRevision(rest: string): string | null {
  const gap = rest.indexOf("..");
  if (gap === -1) return null;
  const after = rest.slice(gap + 2);
  const end = after.indexOf(" ");
  const head = end === -1 ? after : after.slice(0, end);
  return head.length === 0 ? null : head;
}

function parseEntries(patch: string): ReadonlyArray<Omit<Entry, "inBody">> {
  const entries: Array<Omit<Entry, "inBody">> = [];
  let entry: Entry | null = null;

  const close = () => {
    if (entry === null) return;
    const { inBody: _inBody, ...closed } = entry;
    entries.push(closed);
    entry = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith(ENTRY)) {
      close();
      const [oldPath, newPath] = headerPaths(line.slice(ENTRY.length));
      entry = { oldPath, newPath, deleted: false, revision: null, inBody: false };
      continue;
    }
    if (entry === null || entry.inBody) continue;
    if (line.startsWith("@@")) {
      entry.inBody = true;
    } else if (line.startsWith("index ")) {
      entry.revision = headRevision(line.slice("index ".length));
    } else if (line.startsWith("deleted file mode")) {
      entry.deleted = true;
    } else if (line.startsWith("rename from ")) {
      entry.oldPath = unquoteGitPatchPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      entry.newPath = unquoteGitPatchPath(line.slice("rename to ".length));
    } else if (line.startsWith("--- ")) {
      entry.oldPath = sidePath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      const side = sidePath(line.slice(4), "b/");
      entry.newPath = side;
      if (side === null) entry.deleted = true;
    }
  }
  close();
  return entries;
}

/** Head blob IDs by head path (old path for deletions); omit files without index lines. */
export function parseDiffFileRevisions(patch: string): ReadonlyMap<string, string> {
  const revisions = new Map<string, string>();
  for (const entry of parseEntries(patch)) {
    const path = entry.deleted ? entry.oldPath : (entry.newPath ?? entry.oldPath);
    if (path !== null && path.length > 0 && entry.revision !== null) {
      revisions.set(path, entry.revision);
    }
  }
  return revisions;
}

export function parseDiffFilePaths(
  patch: string,
): ReadonlyArray<{ readonly oldPath: string | null; readonly newPath: string | null }> {
  return parseEntries(patch).flatMap(({ oldPath, newPath }) =>
    (oldPath ?? newPath) === null ? [] : [{ oldPath, newPath }],
  );
}

/** The canonical head path names a section, or the old path when the file was deleted. */
export function diffFileSection(patch: string, path: string): string | null {
  let found: string | null = null;
  let start = patch.startsWith(ENTRY) ? 0 : patch.indexOf("\n" + ENTRY) + 1;
  while (patch.startsWith(ENTRY, start)) {
    const next = patch.indexOf("\n" + ENTRY, start);
    const end = next < 0 ? patch.length : next + 1;
    const hunk = patch.indexOf("\n@@", start);
    const headerEnd = hunk < 0 ? end : Math.min(end, hunk);
    if (headerEnd - start <= MAX_DIFF_HEADER_LENGTH) {
      const [entry] = parseEntries(patch.slice(start, headerEnd));
      if (entry && (entry.deleted ? entry.oldPath : (entry.newPath ?? entry.oldPath)) === path) {
        if (found !== null) return null;
        found = patch.slice(start, end);
      }
    }
    start = end;
  }
  return found;
}

const MAX_DIFF_HEADER_LENGTH = 64 * 1024;

/** Keep hunk coordinates intact while bounding rendered text and row count. */
export function truncateLongDiffLines(patch: string, maxLineLength: number): string | null {
  const maxPatchLength = 2 * 1024 * 1024;
  const maxRows = 20_000;
  let inHunk = false;
  let size = 0;
  const lines: string[] = [];
  for (let start = 0; start < patch.length;) {
    const next = patch.indexOf("\n", start);
    const end = next === -1 ? patch.length : next + 1;
    if (patch.startsWith("@@", start)) inHunk = true;
    const lineEnd = next === -1 ? end : next;
    const boundary = start + maxLineLength + 1;
    const prior = patch.charCodeAt(boundary - 1);
    const limit = prior >= 0xd800 && prior <= 0xdbff ? boundary - 1 : boundary;
    const canCut = inHunk && " +-".includes(patch.charAt(start));
    const line =
      canCut && lineEnd > limit
        ? patch.slice(start, limit) + cutLineNote(lineEnd - limit) + (next === -1 ? "" : "\n")
        : patch.slice(start, end);
    size += line.length;
    if (size > maxPatchLength || lines.length >= maxRows) return null;
    lines.push(line);
    start = end;
  }
  return lines.join("");
}
