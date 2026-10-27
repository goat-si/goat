import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@goat/client-runtime/state/pull-requests";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import {
  pullRequestListHead,
  EMPTY_PULL_REQUEST_STATS_CACHE,
  withListedPullRequests,
  withAnsweredPullRequestStats,
  type PullRequestStatsCache,
  type PullRequestListPages,
} from "../features/pull-requests/pullRequestList";
import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestListPagesFamily = Atom.family((_key: string) =>
  Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<PullRequestStatsCache>(EMPTY_PULL_REQUEST_STATS_CACHE).pipe(
    Atom.setIdleTTL(5 * 60_000),
  ),
);

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  list: (target, value, registry) =>
    Effect.sync(() => {
      const statsAtom = pullRequestListStatsFamily(target.environmentId);
      const { cache, refresh } = withListedPullRequests(registry.get(statsAtom), value.entries);
      registry.set(statsAtom, cache);
      for (const input of refresh)
        registry.refresh(
          composerPullRequests.listStats({ environmentId: target.environmentId, input }),
        );
      if (target.input.cursors === undefined)
        registry.update(pullRequestListPagesFamily(JSON.stringify(target)), (previous) =>
          pullRequestListHead(previous, value),
        );
    }),
  listStats: (target, value, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestListStatsFamily(target.environmentId), (previous) =>
        withAnsweredPullRequestStats(previous, target.input, value.stats),
      ),
    ),
});
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
