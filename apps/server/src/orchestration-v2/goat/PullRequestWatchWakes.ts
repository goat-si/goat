/**
 * A watch wake is a queued message, so it starts its own turn only when the thread's current turn
 * ends, which can be hours later. Its id names the pull request, so when the watch is stopped or
 * the pull request merges or closes, the wakes it left queued can be dropped instead of reporting
 * a stale conflict or check (#926).
 *
 * @module PullRequestWatchWakes
 */
import {
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadPullRequestKey,
} from "@goat/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  threadPullRequestsOf,
} from "@goat/shared/threadPullRequests";
import * as Effect from "effect/Effect";

/** A link as the thread stores it, so both sides normalize the same key. */
type WatchedLink = Parameters<typeof threadPullRequestKeyOf>[0];

const wakePrefix = (key: WatchedLink) =>
  `message:pr-watch:${encodeURIComponent(threadPullRequestKeyOf(key))}:`;

export const pullRequestWakeMessageId = (key: WatchedLink, unique: string) =>
  MessageId.make(wakePrefix(key) + unique);

const queuedPullRequestWakes = (runs: ReadonlyArray<OrchestrationV2Run>, key: WatchedLink) => {
  const prefix = wakePrefix(key);
  return runs.filter((run) => run.status === "queued" && run.userMessageId.startsWith(prefix));
};

/** Cancels the wakes queued for the pull request a stopped or merged or closed watch named. */
export const dropQueuedPullRequestWakes = Effect.fn("PullRequestWatchWakes.dropQueued")(function* <
  E,
  R,
  E2,
  R2,
>(
  key: ThreadPullRequestKey,
  records: Effect.Effect<
    {
      readonly thread: Parameters<typeof threadPullRequestsOf>[0];
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
    },
    E,
    R
  >,
  cancel: (runId: RunId) => Effect.Effect<void, E2, R2>,
) {
  const { thread, runs } = yield* records;
  const normalized = normalizeThreadPullRequestKey(key);
  // The stored link carries the url the reactor named the wake from.
  const link =
    threadPullRequestsOf(thread).find((candidate) =>
      threadPullRequestKeysEqual(candidate, normalized),
    ) ?? normalized;
  for (const run of queuedPullRequestWakes(runs, link)) yield* cancel(run.id);
});
