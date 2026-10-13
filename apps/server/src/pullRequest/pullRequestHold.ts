import type { PullRequestLabel } from "@goat/contracts";

/** Label names that put a pull request on hold, compared after `normalizeLabel`. */
const HOLD_LABELS = new Set(["hold", "on-hold", "do-not-merge", "dont-merge"]);

/** A description line that starts with HOLD, such as `HOLD: do not merge until review`. */
const HOLD_LINE = /^[\s>*_#-]*HOLD\b/m;

const normalizeLabel = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/['’]/g, "")
    .replaceAll(/[\s_]+/g, "-");

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
  if (HOLD_LINE.test(pullRequest.body)) return "its description has a HOLD line";
  return null;
}
