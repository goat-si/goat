/** Each feed holds a host connection and subscription; watches past the cap rely on the sweep. */
export const MAX_EVENT_FEEDS = 64;
/**
 * A wake costs the user a provider turn, so a burst of host events (check suites, a review's
 * comments) settles into one read; the sweep still reads every two minutes.
 */
export const EVENT_SETTLE = "20 seconds";

/** The first feeds by key, so the same pull requests keep theirs from sweep to sweep. */
export const feedsToFollow = <A>(candidates: Iterable<readonly [string, A]>) =>
  new Map(
    [...new Map(candidates)]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .slice(0, MAX_EVENT_FEEDS),
  );
