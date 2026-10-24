/**
 * A watch wake is a queued message, so it starts its own turn only when the thread's current turn
 * ends, which can be hours later. Its id names the pull request, so when the watch is stopped or
 * the pull request merges or closes, the wakes it left queued can be dropped instead of reporting
 * a stale conflict or check (#926). A wake that reports only check results also names the head they
 * ran on, so a push drops it: the new head's checks are reported on their own (#1056).
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

export const PULL_REQUEST_WAKE_MESSAGE_PREFIX = "message:pr-watch:";

const wakePrefix = (key: WatchedLink) =>
  `${PULL_REQUEST_WAKE_MESSAGE_PREFIX}${encodeURIComponent(threadPullRequestKeyOf(key))}:`;

const CHECKS_ON = "checks@";

/** `checksOn` is the head a wake reports nothing but check results for. */
export const pullRequestWakeMessageId = (
  key: WatchedLink,
  unique: string,
  checksOn?: string | null,
) =>
  MessageId.make(
    wakePrefix(key) + (checksOn ? `${CHECKS_ON}${encodeURIComponent(checksOn)}:` : "") + unique,
  );

/** The head a wake's check results ran on, or null when it reports anything else. */
const checksHead = (id: string, prefix: string) => {
  const rest = id.slice(prefix.length);
  if (!rest.startsWith(CHECKS_ON)) return null;
  return decodeURIComponent(rest.slice(CHECKS_ON.length, rest.indexOf(":")));
};

const queuedPullRequestWakes = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  key: WatchedLink,
  headSha: string | undefined,
) => {
  const prefix = wakePrefix(key);
  return runs.filter((run) => {
    if (run.status !== "queued" || !run.userMessageId.startsWith(prefix)) return false;
    if (headSha === undefined) return true;
    const ranOn = checksHead(run.userMessageId, prefix);
    return ranOn !== null && ranOn !== headSha;
  });
};

/**
 * Cancels the wakes queued for the pull request a stopped or merged or closed watch named. Given
 * the pull request's new head, it cancels only the check results of other heads.
 */
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
  headSha?: string,
) {
  const { thread, runs } = yield* records;
  const normalized = normalizeThreadPullRequestKey(key);
  // The stored link carries the url the reactor named the wake from.
  const link =
    threadPullRequestsOf(thread).find((candidate) =>
      threadPullRequestKeysEqual(candidate, normalized),
    ) ?? normalized;
  for (const run of queuedPullRequestWakes(runs, link, headSha)) yield* cancel(run.id);
});
