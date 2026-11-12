import {
  REMOTE_LAUNCHES_DEFAULT_LIMIT,
  REMOTE_LAUNCHES_WS_METHODS,
  RemoteLaunchesError,
  ThreadId,
  WsRemoteLaunchesRpcGroup,
  type RemoteLaunch,
  type RemoteLaunchDismissInput,
  type RemoteLaunchDismissResult,
  type RemoteLaunchesListInput,
  type RemoteLaunchesListResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LaunchWatch } from "../mcp/launchWatch.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { isDismissable } from "./remoteDispatchDismiss.ts";
import { remoteThreadKey } from "./remoteDispatchRow.ts";
import * as RemoteDispatchCoordinator from "./RemoteDispatchCoordinator.ts";

/**
 * Lists the threads this environment launched or watches on other machines, so
 * a client that is not on this machine can find and open them, and stops following
 * one whose host no longer answers. Neither contacts a host.
 */
export class RemoteLaunchCatalog extends Context.Service<
  RemoteLaunchCatalog,
  {
    readonly list: (
      input: RemoteLaunchesListInput,
    ) => Effect.Effect<RemoteLaunchesListResult, RemoteLaunchesError>;
    readonly dismiss: (
      input: RemoteLaunchDismissInput,
    ) => Effect.Effect<RemoteLaunchDismissResult, RemoteLaunchesError>;
  }
>()("goat/remoteReports/RemoteLaunchCatalog") {}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const threadKey = (host: string, threadId: string) => `${host}\u0000${threadId}`;
// Watches live in memory, so reading all of them costs nothing a page would save.
const ALL_WATCHES = Number.MAX_SAFE_INTEGER;

/**
 * One entry per remote thread, combining its dispatch records and launch watches. Inputs are
 * newest first; the newest record not dismissed speaks for the thread, so a dismissed one never
 * hides a sibling that is still followed.
 */
export function mergeRemoteLaunches(input: {
  readonly dispatches: ReadonlyArray<RemoteDispatchCoordinator.RemoteDispatchRecord>;
  readonly watches: ReadonlyArray<LaunchWatch>;
  readonly limit: number;
}): RemoteLaunchesListResult {
  const groups = new Map<string, Array<RemoteDispatchCoordinator.RemoteDispatchRecord>>();
  for (const dispatch of input.dispatches) {
    const key =
      dispatch.remoteThreadId === null
        ? `dispatch:${dispatch.correlationId}`
        : threadKey(dispatch.host, dispatch.remoteThreadId);
    groups.set(key, [...(groups.get(key) ?? []), dispatch]);
  }
  const entries = new Map<string, RemoteLaunch>();
  for (const [key, members] of groups) {
    const shown = members.find((member) => member.endReason !== "dismissed") ?? members[0];
    if (shown === undefined) continue;
    const outage = shown.state === "running" || shown.endReason === "host_unreachable";
    entries.set(key, {
      host: shown.host,
      threadId: shown.remoteThreadId === null ? null : ThreadId.make(shown.remoteThreadId),
      title: null,
      launcherThreadId: shown.originThreadId,
      source: shown.kind,
      state: shown.state,
      latest: RemoteDispatchCoordinator.dispatchView(shown).latest,
      hostUnavailableSince: outage ? shown.hostUnavailableSince : null,
      updatedAt: shown.updatedAt,
      dismissable: members.some(isDismissable),
      dismissedAt: shown.endReason === "dismissed" ? shown.endedAt : null,
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
        dismissable: watch.outage !== null,
        dismissedAt: null,
      });
      continue;
    }
    const watchUpdatedAt = iso(watch.updatedAt);
    entries.set(key, {
      ...existing,
      title: existing.title ?? watch.title,
      hostUnavailableSince: existing.hostUnavailableSince ?? unavailableSince,
      dismissable: existing.dismissable === true || watch.outage !== null,
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
  const failed = (action: string) => (cause: { readonly message: string }) =>
    new RemoteLaunchesError({ message: `Could not ${action} remote launches: ${cause.message}` });
  const list = Effect.fn("RemoteLaunchCatalog.list")(
    function* (input: RemoteLaunchesListInput) {
      const limit = input.limit ?? REMOTE_LAUNCHES_DEFAULT_LIMIT;
      // One extra row tells a full page from a truncated one.
      const [recent, remoteWatches] = yield* Effect.all(
        [coordinator.listRecent(limit + 1), watches.listRemote(ALL_WATCHES)],
        { concurrency: 2 },
      );
      // The page decides which threads show; each shown thread then counts all of its records.
      const keys = mergeRemoteLaunches({
        dispatches: recent,
        watches: remoteWatches,
        limit,
      }).launches.flatMap((launch) =>
        launch.threadId === null ? [] : [remoteThreadKey(launch.host, launch.threadId)],
      );
      const members = keys.length === 0 ? [] : yield* coordinator.listForRemoteThreads(keys);
      const seen = new Set(members.map((member) => member.correlationId));
      const dispatches = [
        ...members,
        ...recent.filter((dispatch) => !seen.has(dispatch.correlationId)),
      ].toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      return mergeRemoteLaunches({ dispatches, watches: remoteWatches, limit });
    },
    Effect.mapError(failed("read")),
  );
  const dismiss = Effect.fn("RemoteLaunchCatalog.dismiss")(
    function* (input: RemoteLaunchDismissInput) {
      const dismissed = yield* coordinator.dismiss({
        host: input.host,
        remoteThreadId: input.threadId,
      });
      let removed = 0;
      for (const watch of yield* watches.listRemote(ALL_WATCHES)) {
        if (watch.host !== input.host || watch.threadId !== input.threadId) continue;
        if (watch.launcherThreadId === null || watch.outage === null) continue;
        // Removed only if it is still this watch and its host still does not answer.
        const target = { launcherThreadId: watch.launcherThreadId, host: watch.host };
        const gone = yield* watches.unwatch(
          { ...target, threadId: watch.threadId },
          { incarnation: watch.incarnation },
        );
        if (gone) removed += 1;
      }
      return { dispatches: dismissed.length, watches: removed };
    },
    Effect.mapError(failed("dismiss")),
  );
  return RemoteLaunchCatalog.of({ list, dismiss });
});

/**
 * Needs the server's single LaunchWatchService and RemoteDispatchCoordinator:
 * both follow runs and wake launchers, so a second instance would wake them twice.
 */
export const layerWithoutDependencies = Layer.effect(RemoteLaunchCatalog, make);

const group = WsRemoteLaunchesRpcGroup.middleware(RpcInstrumentation);
/** The remote launch RPCs, served by one connection's handlers like the other RPC groups. */
export const makeRpcLayer = (catalog: RemoteLaunchCatalog["Service"]) =>
  group.toLayer(
    group.of({
      [REMOTE_LAUNCHES_WS_METHODS.list]: (input) => catalog.list(input),
      [REMOTE_LAUNCHES_WS_METHODS.dismiss]: (input) => catalog.dismiss(input),
    }),
  );
