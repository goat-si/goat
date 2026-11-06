import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
  patchPullRequestListEntries,
} from "@goat/client-runtime/state/pull-requests";
import type { EnvironmentId, PullRequestListInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  pullRequestListHead,
  EMPTY_PULL_REQUEST_STATS_CACHE,
  withListedPullRequests,
  withAnsweredPullRequestStats,
  type PullRequestStatsCache,
  type PullRequestListPages,
} from "../features/pull-requests/pullRequestList";
import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestListPagesKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestListInput;
}) => JSON.stringify(target);

// Which listing each pages atom holds, so an action's reply can reach the pages past its head.
const pullRequestListPagesTargets = new WeakMap<
  object,
  { readonly environmentId: EnvironmentId; readonly input: PullRequestListInput }
>();
/** The pages loaded past each listing's head, keyed by {@link pullRequestListPagesKey}. */
export const pullRequestListPagesFamily = Atom.family((key: string) => {
  const atom = Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000));
  pullRequestListPagesTargets.set(atom, JSON.parse(key));
  return atom;
});

/** Diff stats each environment has answered so far, so rows keep them when they scroll away. */
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<PullRequestStatsCache>(EMPTY_PULL_REQUEST_STATS_CACHE).pipe(
    Atom.setIdleTTL(5 * 60_000),
  ),
);

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  // Rows on pages past each listing's head; the head itself is patched where it is cached.
  actionReply: (target, reply, registry) =>
    Effect.sync(() => {
      for (const atom of registry.getNodes().keys()) {
        const listing =
          typeof atom === "string" ? undefined : pullRequestListPagesTargets.get(atom);
        if (listing === undefined || listing.environmentId !== target.environmentId) continue;
        registry.update(atom as Atom.Writable<PullRequestListPages | null>, (pages) => {
          if (pages === null) return pages;
          const entries = patchPullRequestListEntries(
            listing.input,
            pages.entries,
            target.input,
            reply,
          );
          return entries === "refresh" || entries === pages.entries ? pages : { ...pages, entries };
        });
      }
    }),
  // A new head can change which files GitHub still counts as viewed, so the viewed-files read is
  // refreshed where the new head lands. The detail atom still holds the previous answer here.
  detail: (target, value, registry) =>
    Effect.sync(() => {
      const previous = AsyncResult.value(registry.get(composerPullRequests.detail(target)));
      if (Option.isSome(previous) && previous.value.headSha !== value.headSha)
        registry.refresh(composerPullRequests.filesViewed(target));
    }),
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
