import type { PullRequestLabel } from "@goat/contracts";

/** Label names that put a pull request on hold, compared after `normalizeLabel`. */
const HOLD_LABELS = new Set(["hold", "on-hold", "do-not-merge", "dont-merge"]);

/**
 * A rendered line that starts with HOLD, such as `HOLD: do not merge until review`, after any
 * quote, heading, list marker (`-`, `1.`), emphasis, or inline code that opens it.
 */
const HOLD_LINE = /^(?:[\s>#*_~`+-]|\d+[.)])*HOLD\b/;

/** A fence line; the run of backticks or tildes opens a code block and closes it again. */
const FENCE = /^[ \t>]*(`{3,}|~{3,})/;

/** Separators collapse, so `On Hold`, `do_not_merge` and `do - not - merge` all match. */
const normalizeLabel = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/['’]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

/** Whether a line a reader would see starts with HOLD. Fenced code and HTML comments are hidden. */
function hasHoldLine(body: string): boolean {
  let fence: string | null = null;
  let inComment = false;
  for (const raw of body.split(/\r?\n/)) {
    let line = raw;
    if (fence !== null) {
      const close = FENCE.exec(line)?.[1];
      if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) {
        if (line.slice(line.indexOf(close) + close.length).trim() === "") fence = null;
      }
      continue;
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
    const opening = FENCE.exec(line)?.[1];
    if (opening !== undefined && !inComment) {
      fence = opening;
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
