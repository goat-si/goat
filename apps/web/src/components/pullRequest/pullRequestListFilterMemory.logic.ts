import type { PullRequestActor, PullRequestLabel } from "@goat/contracts";

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * The host's answers across a picker's searches, one per key with the newest answer first, so a
 * choice found by an earlier search keeps its color or avatar. Returns `seen` itself when nothing
 * changed.
 */
function rememberHostAnswers<Item>(
  seen: ReadonlyArray<Item>,
  hosted: ReadonlyArray<Item>,
  key: (item: Item) => string | null,
  same: (left: Item, right: Item) => boolean,
): ReadonlyArray<Item> {
  if (hosted.length === 0) return seen;
  const answered = new Map<string | null, Item>();
  for (const item of hosted) {
    const itemKey = key(item);
    if (!answered.has(itemKey)) answered.set(itemKey, item);
  }
  const next = [...answered.values(), ...seen.filter((held) => !answered.has(key(held)))];
  const unchanged =
    next.length === seen.length &&
    next.every((item, index) => {
      const held = seen[index];
      return held !== undefined && same(item, held);
    });
  return unchanged ? seen : next;
}

export function rememberPullRequestLabels(
  seen: ReadonlyArray<PullRequestLabel>,
  hosted: ReadonlyArray<PullRequestLabel>,
): ReadonlyArray<PullRequestLabel> {
  return rememberHostAnswers(
    seen,
    hosted,
    (label) => normalize(label.name),
    (left, right) => left.name === right.name && left.color === right.color,
  );
}

export function rememberPullRequestAuthors(
  seen: ReadonlyArray<PullRequestActor>,
  hosted: ReadonlyArray<PullRequestActor>,
): ReadonlyArray<PullRequestActor> {
  return rememberHostAnswers(
    seen,
    hosted,
    (actor) => normalize(actor.login),
    (left, right) =>
      left.login === right.login &&
      left.name === right.name &&
      left.avatarUrl === right.avatarUrl &&
      left.isBot === right.isBot,
  );
}
