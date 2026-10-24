/**
 * A watch wake is a queued message, so it starts its own turn only when the thread's current turn
 * ends, which can be hours later. Its id names the pull request, so when the watch is stopped or
 * the pull request merges or closes, the wakes it left queued can be dropped instead of reporting
 * a stale conflict or check (#926). A wake that reports only check results also names the head they
 * ran on, so a push drops it: the new head's checks are reported on their own (#1056).
 *
 * @module PullRequestWatchWakes
 */
import { MessageId } from "@goat/contracts";
import { threadPullRequestKeyOf } from "@goat/shared/threadPullRequests";

/** A link as the thread stores it, so both sides normalize the same key. */
export type WatchedLink = Parameters<typeof threadPullRequestKeyOf>[0];

export const PULL_REQUEST_WAKE_MESSAGE_PREFIX = "message:pr-watch:";

export const pullRequestWakePrefix = (key: WatchedLink) =>
  `${PULL_REQUEST_WAKE_MESSAGE_PREFIX}${encodeURIComponent(threadPullRequestKeyOf(key))}:`;

const CHECKS_ON = "checks@";

/** `checksOn` is the head a wake reports nothing but check results for. */
export const pullRequestWakeMessageId = (
  key: WatchedLink,
  unique: string,
  checksOn?: string | null,
) =>
  MessageId.make(
    pullRequestWakePrefix(key) +
      (checksOn ? `${CHECKS_ON}${encodeURIComponent(checksOn)}:` : "") +
      unique,
  );

/** The notice id of a pull request's kept context inside a digest. */
export const pullRequestHeldNoticeId = (key: WatchedLink) => `${pullRequestWakePrefix(key)}held`;

/** The head a wake's check results ran on, or null when it reports anything else. */
export const pullRequestWakeChecksHead = (id: string, prefix: string) => {
  const rest = id.slice(prefix.length);
  if (!rest.startsWith(CHECKS_ON)) return null;
  return decodeURIComponent(rest.slice(CHECKS_ON.length, rest.indexOf(":")));
};
