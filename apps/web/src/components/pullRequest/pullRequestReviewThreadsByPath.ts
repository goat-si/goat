import type { PullRequestReviewThread } from "@goat/contracts";

const threadsByPathCache = new WeakMap<
  ReadonlyArray<PullRequestReviewThread>,
  ReadonlyMap<string, ReadonlyArray<PullRequestReviewThread>>
>();

export function reviewThreadsByPath(threads: ReadonlyArray<PullRequestReviewThread>) {
  let byPath = threadsByPathCache.get(threads);
  if (byPath === undefined) {
    const grouped = new Map<string, PullRequestReviewThread[]>();
    for (const thread of threads) {
      const list = grouped.get(thread.path);
      if (list) list.push(thread);
      else grouped.set(thread.path, [thread]);
    }
    threadsByPathCache.set(threads, (byPath = grouped));
  }
  return byPath;
}
