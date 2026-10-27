import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@goat/client-runtime/state/pull-requests";
import type { PullRequestDiffStat } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import {
  pullRequestListHead,
  pullRequestStatKey,
  type PullRequestListPages,
} from "../features/pull-requests/pullRequestList";
import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestListPagesFamily = Atom.family((_key: string) =>
  Atom.make<PullRequestListPages | null>(null).pipe(Atom.setIdleTTL(5 * 60_000)),
);
export const pullRequestListStatsFamily = Atom.family((_environmentId: string) =>
  Atom.make<ReadonlyMap<string, PullRequestDiffStat>>(new Map()).pipe(Atom.setIdleTTL(5 * 60_000)),
);

export const composerPullRequests = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  list: (target, value, registry) =>
    target.input.cursors === undefined
      ? Effect.sync(() =>
          registry.update(pullRequestListPagesFamily(JSON.stringify(target)), (previous) =>
            pullRequestListHead(previous, value),
          ),
        )
      : Effect.void,
  listStats: (target, value, registry) =>
    Effect.sync(() =>
      registry.update(pullRequestListStatsFamily(target.environmentId), (previous) => {
        const next = new Map(previous);
        for (const row of value.stats) next.set(pullRequestStatKey(row), row);
        return next;
      }),
    ),
});
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
