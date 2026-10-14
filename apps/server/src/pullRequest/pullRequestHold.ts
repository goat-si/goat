import type { PullRequestLabel } from "@goat/contracts";

/** Label names that put a pull request on hold, compared after `normalizeLabel`. */
const HOLD_LABELS = new Set(["hold", "on-hold", "do-not-merge", "dont-merge"]);

/**
 * A rendered line that starts with HOLD, such as `HOLD: do not merge until review`, after any
 * quote, heading, list marker (`-`, `1.`), emphasis, or inline code that opens it.
 */
const HOLD_LINE = /^(?:[\s>#*_~`+-]|\d+[.)])*HOLD\b/;

/** A fence: a run of backticks or tildes that opens a code block, and closes it again. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** A list item marker with the spaces after it; its length is the item's content indent. */
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/** Splits off the blockquote markers that open a line, and counts them. */
function unquote(line: string): { readonly depth: number; readonly rest: string } {
  let depth = 0;
  let rest = line;
  for (let quote = /^[ \t]*> ?/.exec(rest); quote !== null; quote = /^[ \t]*> ?/.exec(rest)) {
    depth++;
    rest = rest.slice(quote[0].length);
  }
  return { depth, rest };
}

/** Separators collapse, so `On Hold`, `do_not_merge` and `do - not - merge` all match. */
const normalizeLabel = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/['’]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

/**
 * Whether a line a reader would see starts with HOLD. Fenced code and HTML comments are hidden.
 * A fence belongs to the blockquote or list item it opened in and ends with it, as it renders.
 */
function hasHoldLine(body: string): boolean {
  let fence: { readonly marker: string; readonly depth: number; readonly indent: number } | null =
    null;
  let inComment = false;
  for (const raw of body.split(/\r?\n/)) {
    let line = raw;
    if (fence !== null) {
      const { depth, rest } = unquote(line);
      const blank = rest.trim() === "";
      const indent = /^[ \t]*/.exec(rest)![0].length;
      const inside = depth >= fence.depth && (blank || indent >= fence.indent);
      if (inside || (blank && fence.depth === 0)) {
        const close = FENCE.exec(rest.slice(fence.indent));
        if (
          close !== null &&
          close[1]![0] === fence.marker[0] &&
          close[1]!.length >= fence.marker.length &&
          rest.slice(fence.indent + close[0].length).trim() === ""
        )
          fence = null;
        continue;
      }
      // The blockquote or list item holding the fence has ended, and the fence with it.
      fence = null;
    }
    if (inComment) {
      const end = line.indexOf("-->");
      if (end === -1) continue;
      inComment = false;
      line = line.slice(end + 3);
    }
    line = line.replaceAll(/<!--[\s\S]*?-->/g, "");
    const open = line.indexOf("<!--");
    if (open !== -1) {
      inComment = true;
      line = line.slice(0, open);
    }
    const { depth, rest } = unquote(line);
    const item = LIST_MARKER.exec(rest)?.[0] ?? "";
    const opening = FENCE.exec(rest.slice(item.length))?.[1];
    if (opening !== undefined && !inComment) {
      fence = { marker: opening, depth, indent: item.length };
      continue;
    }
    if (HOLD_LINE.test(line)) return true;
  }
  return false;
}

/**
 * Why a pull request must not be merged yet, or null when nothing holds it. A merge,
 * or an auto-merge armed for later, is refused while a reason stands; the author
 * clears it by marking the pull request ready, removing the label, or editing the line.
 */
export function pullRequestHoldReason(pullRequest: {
  readonly isDraft: boolean;
  readonly labels: ReadonlyArray<Pick<PullRequestLabel, "name">>;
  readonly body: string;
}): string | null {
  if (pullRequest.isDraft) return "it is still a draft";
  const label = pullRequest.labels.find((candidate) =>
    HOLD_LABELS.has(normalizeLabel(candidate.name)),
  );
  if (label !== undefined) return `it has the "${label.name}" label`;
  if (hasHoldLine(pullRequest.body)) return "its description has a HOLD line";
  return null;
}
