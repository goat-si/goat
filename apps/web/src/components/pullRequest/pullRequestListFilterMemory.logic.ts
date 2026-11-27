import type { PullRequestLabel } from "@goat/contracts";

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * The host's labels across a picker's searches, one per name with the newest answer first, so a
 * label found by an earlier search keeps its color. Returns `seen` itself when nothing changed.
 */
export function rememberPullRequestLabels(
  seen: ReadonlyArray<PullRequestLabel>,
  hosted: ReadonlyArray<PullRequestLabel>,
): ReadonlyArray<PullRequestLabel> {
  if (hosted.length === 0) return seen;
  const answered = new Map<string | null, PullRequestLabel>();
  for (const label of hosted) {
    const key = normalize(label.name);
    if (!answered.has(key)) answered.set(key, label);
  }
  const next = [
    ...answered.values(),
    ...seen.filter((held) => !answered.has(normalize(held.name))),
  ];
  const same =
    next.length === seen.length &&
    next.every(
      (label, index) => label.name === seen[index]?.name && label.color === seen[index]?.color,
    );
  return same ? seen : next;
}
