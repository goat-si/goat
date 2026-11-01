import {
  REMOTE_LAUNCHES_DEFAULT_LIMIT,
  RemoteLaunchesError,
  ThreadId,
  type RemoteLaunch,
  type RemoteLaunchesListInput,
  type RemoteLaunchesListResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LaunchWatch } from "../mcp/launchWatch.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as RemoteDispatchCoordinator from "./RemoteDispatchCoordinator.ts";

/**
 * Lists the threads this environment launched or watches on other machines, so
 * a client that is not on this machine can find and open them. Read-only: it
 * reads the dispatch records and launch watches and contacts no host.
 */
export class RemoteLaunchCatalog extends Context.Service<
  RemoteLaunchCatalog,
  {
    readonly list: (
      input: RemoteLaunchesListInput,
    ) => Effect.Effect<RemoteLaunchesListResult, RemoteLaunchesError>;
  }
>()("goat/remoteReports/RemoteLaunchCatalog") {}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const threadKey = (host: string, threadId: string) => `${host}\u0000${threadId}`;

/**
 * One entry per remote thread. A dispatch record knows the run state and the
 * latest report; a launch watch knows the title and whether the host is
 * unreachable, so both are combined when they name the same (host, thread).
 * Inputs are newest first; the newest record for a thread names its launcher.
 */
export function mergeRemoteLaunches(input: {
  readonly dispatches: ReadonlyArray<RemoteDispatchCoordinator.RemoteDispatchRecord>;
  readonly watches: ReadonlyArray<LaunchWatch>;
  readonly limit: number;
}): RemoteLaunchesListResult {
  const entries = new Map<string, RemoteLaunch>();
  for (const dispatch of input.dispatches) {
    const key =
      dispatch.remoteThreadId === null
        ? `dispatch:${dispatch.correlationId}`
        : threadKey(dispatch.host, dispatch.remoteThreadId);
    if (entries.has(key)) continue;
    entries.set(key, {
      host: dispatch.host,
      threadId: dispatch.remoteThreadId === null ? null : ThreadId.make(dispatch.remoteThreadId),
      title: null,
      launcherThreadId: dispatch.originThreadId,
      source: dispatch.kind,
      state: dispatch.state,
      latest: RemoteDispatchCoordinator.dispatchView(dispatch).latest,
      hostUnavailableSince: null,
      updatedAt: dispatch.updatedAt,
    });
  }
  for (const watch of input.watches) {
    // A launcherless watch, for an outside client's launch, has no launcher thread to show.
    if (watch.host === null || watch.launcherThreadId === null) continue;
    const key = threadKey(watch.host, watch.threadId);
    const unavailableSince = watch.outage === null ? null : iso(watch.outage.since);
    const existing = entries.get(key);
    if (existing === undefined) {
      entries.set(key, {
        host: watch.host,
        threadId: watch.threadId,
        title: watch.title,
        launcherThreadId: watch.launcherThreadId,
        source: "watch",
        state: null,
        latest: null,
        hostUnavailableSince: unavailableSince,
        updatedAt: iso(watch.updatedAt),
      });
      continue;
    }
    const watchUpdatedAt = iso(watch.updatedAt);
    entries.set(key, {
      ...existing,
      title: existing.title ?? watch.title,
      hostUnavailableSince: existing.hostUnavailableSince ?? unavailableSince,
      updatedAt:
        Date.parse(watchUpdatedAt) > Date.parse(existing.updatedAt)
          ? watchUpdatedAt
          : existing.updatedAt,
    });
  }
  const launches = [...entries.values()].toSorted(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  return { launches: launches.slice(0, input.limit), truncated: launches.length > input.limit };
}

const make = Effect.gen(function* () {
  const coordinator = yield* RemoteDispatchCoordinator.RemoteDispatchCoordinator;
  const watches = yield* LaunchWatchService.LaunchWatchService;
  const list = Effect.fn("RemoteLaunchCatalog.list")(function* (input: RemoteLaunchesListInput) {
    const limit = input.limit ?? REMOTE_LAUNCHES_DEFAULT_LIMIT;
    // One extra row tells a full page from a truncated one.
    const [dispatches, remoteWatches] = yield* Effect.all(
      [coordinator.listRecent(limit + 1), watches.listRemote(limit + 1)],
      { concurrency: 2 },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new RemoteLaunchesError({ message: `Could not read remote launches: ${cause.message}` }),
      ),
    );
    return mergeRemoteLaunches({ dispatches, watches: remoteWatches, limit });
  });
  return RemoteLaunchCatalog.of({ list });
});

/**
 * Needs the server's single LaunchWatchService and RemoteDispatchCoordinator:
 * both follow runs and wake launchers, so a second instance would wake them twice.
 */
export const layerWithoutDependencies = Layer.effect(RemoteLaunchCatalog, make);
