import type { PullRequestReviewThread } from "@goat/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { isLineInFileDiff } from "./pullRequestDiff.logic";

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

export function placedReviewThreadIds(
  files: ReadonlyArray<FileDiffMetadata>,
  threadsByPath: ReadonlyMap<string, ReadonlyArray<PullRequestReviewThread>>,
  commit: string | null,
): Set<string> {
  const placed = new Set<string>();
  // Commit diffs use different line coordinates; list conversations separately.
  if (commit !== null) return placed;
  for (const file of files) {
    for (const thread of threadsByPath.get(resolveFileDiffPath(file)) ?? []) {
      if (thread.line !== null && isLineInFileDiff(file, thread.side, thread.line)) {
        placed.add(thread.id);
      }
    }
  }
  return placed;
}
