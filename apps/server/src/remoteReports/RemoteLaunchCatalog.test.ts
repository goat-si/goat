import { assert, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { newLaunchWatch, type LaunchWatch } from "../mcp/launchWatch.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import * as Catalog from "./RemoteLaunchCatalog.ts";

const launcher = ThreadId.make("launcher");
const otherLauncher = ThreadId.make("other-launcher");
const remote = ThreadId.make("remote");
const ms = (iso: string) => Date.parse(iso);

const dispatch = (
  overrides: Partial<Coordinator.RemoteDispatchRecord> = {},
): Coordinator.RemoteDispatchRecord => ({
  memoryGrantCeiling: "none",
  correlationId: "dispatch-1",
  kind: "thread",
  originThreadId: launcher,
  host: "builder",
  remoteThreadId: remote,
  launchedRunId: RunId.make("run-1"),
  delivery: "wake",
  reportsSupported: true,
  state: "running",
  reportCursor: 0,
  knownRunId: null,
  knownRunStatus: null,
  latestKind: "progress",
  latestSummary: "Halfway there",
  latestAt: "2026-10-12T10:00:00.000Z",
  cancelRequestedAt: null,
  cancelCeiling: null,
  task: null,
  pendingRequestIds: [],
  observation: null,
  lastError: null,
  hostUnavailableSince: null,
  endReason: null,
  endedAt: null,
  createdAt: "2026-10-12T09:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  ...overrides,
});

const watch = (
  input: {
    readonly host: string | null;
    readonly threadId?: ThreadId;
    readonly launcherThreadId?: ThreadId;
    readonly title?: string | null;
    readonly updatedAt: string;
  },
  overrides: Partial<LaunchWatch> = {},
): LaunchWatch => ({
  ...newLaunchWatch({
    launcherThreadId: input.launcherThreadId ?? launcher,
    host: input.host,
    threadId: input.threadId ?? remote,
    projectId: input.host === null ? ProjectId.make("project") : null,
    title: input.title ?? null,
    incarnation: "incarnation",
    notifyWebhook: false,
    now: ms(input.updatedAt),
  }),
  ...overrides,
});

it("combines a dispatch record and a launch watch for the same remote thread", () => {
  const result = Catalog.mergeRemoteLaunches({
    dispatches: [dispatch()],
    watches: [
      watch(
        { host: "builder", title: "Fix the build", updatedAt: "2026-10-12T11:00:00.000Z" },
        {
          outage: {
            since: ms("2026-10-12T10:30:00.000Z"),
            episode: 1,
            failures: 3,
            notified: true,
            nextRetryAt: 0,
            lastError: "ssh failed",
          },
        },
      ),
    ],
    limit: 10,
  });
  assert.deepStrictEqual(result, {
    launches: [
      {
        host: "builder",
        threadId: remote,
        title: "Fix the build",
        launcherThreadId: launcher,
        source: "thread",
        state: "running",
        latest: { kind: "progress", summary: "Halfway there", at: "2026-10-12T10:00:00.000Z" },
        hostUnavailableSince: "2026-10-12T10:30:00.000Z",
        updatedAt: "2026-10-12T11:00:00.000Z",
        dismissable: true,
        dismissedAt: null,
      },
    ],
    truncated: false,
  });
});

it("keeps watch-only and in-flight launches, skips local watches, and sorts newest first", () => {
  const watched = ThreadId.make("watched");
  const result = Catalog.mergeRemoteLaunches({
    dispatches: [
      dispatch({
        correlationId: "in-flight",
        remoteThreadId: null,
        state: "launching",
        latestKind: null,
        latestSummary: null,
        latestAt: null,
        updatedAt: "2026-10-12T12:00:00.000Z",
      }),
    ],
    watches: [
      watch({
        host: null,
        threadId: ThreadId.make("local"),
        updatedAt: "2026-10-12T13:00:00.000Z",
      }),
      watch({
        host: "laptop",
        threadId: watched,
        title: "Watched",
        updatedAt: "2026-10-12T11:00:00.000Z",
      }),
    ],
    limit: 10,
  });
  assert.deepStrictEqual(
    result.launches.map((launch) => [launch.host, launch.threadId, launch.source, launch.state]),
    [
      ["builder", null, "thread", "launching"],
      ["laptop", watched, "watch", null],
    ],
  );
});

it("names the launcher from the newest record when several watch one thread", () => {
  const result = Catalog.mergeRemoteLaunches({
    dispatches: [],
    watches: [
      watch({
        host: "builder",
        launcherThreadId: otherLauncher,
        title: "Newer",
        updatedAt: "2026-10-12T12:00:00.000Z",
      }),
      watch({ host: "builder", title: "Older", updatedAt: "2026-10-12T11:00:00.000Z" }),
    ],
    limit: 10,
  });
  assert.strictEqual(result.launches.length, 1);
  assert.strictEqual(result.launches[0]?.launcherThreadId, otherLauncher);
  assert.strictEqual(result.launches[0]?.title, "Newer");
});

it("reports truncation past the limit", () => {
  const result = Catalog.mergeRemoteLaunches({
    dispatches: [
      dispatch({ correlationId: "a", remoteThreadId: "a", updatedAt: "2026-10-12T12:00:00.000Z" }),
      dispatch({ correlationId: "b", remoteThreadId: "b", updatedAt: "2026-10-12T11:00:00.000Z" }),
    ],
    watches: [],
    limit: 1,
  });
  assert.deepStrictEqual(
    result.launches.map((launch) => launch.threadId),
    [ThreadId.make("a")],
  );
  assert.strictEqual(result.truncated, true);
});

it.effect("reads one row past the limit so a full page is not reported as truncated", () =>
  Effect.gen(function* () {
    const requestedLimits: Array<number> = [];
    const requestedWatchLimits: Array<number> = [];
    const layer = Catalog.layerWithoutDependencies.pipe(
      Layer.provide(
        Layer.mock(Coordinator.RemoteDispatchCoordinator)({
          listRecent: (limit) => {
            requestedLimits.push(limit);
            return Effect.succeed([dispatch()]);
          },
          listForRemoteThreads: () => Effect.succeed([dispatch()]),
        }),
      ),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          listRemote: (limit) => {
            requestedWatchLimits.push(limit);
            return Effect.succeed([]);
          },
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const catalog = yield* Catalog.RemoteLaunchCatalog;
      return yield* catalog.list({ limit: 1 });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(requestedLimits, [2]);
    // Watches are held in memory, so every one is read and merged.
    assert.deepStrictEqual(requestedWatchLimits, [Number.MAX_SAFE_INTEGER]);
    assert.strictEqual(result.launches.length, 1);
    assert.strictEqual(result.truncated, false);
  }),
);

const outage = (since: string) => ({
  since: ms(since),
  episode: 1,
  failures: 3,
  notified: true,
  nextRetryAt: 0,
  lastError: "ssh failed",
});

it("a dispatch's own outage start shows the host as unreachable and offers dismissal", () => {
  const since = "2026-10-12T10:30:00.000Z";
  const launches = Catalog.mergeRemoteLaunches({
    dispatches: [
      dispatch({ correlationId: "away", remoteThreadId: "away", hostUnavailableSince: since }),
      dispatch({ correlationId: "answering", remoteThreadId: "answering" }),
      dispatch({
        correlationId: "ended",
        remoteThreadId: "ended",
        state: "lost",
        endReason: "host_unreachable",
        endedAt: "2026-10-13T10:30:00.000Z",
        hostUnavailableSince: since,
      }),
      dispatch({ correlationId: "unknown-launch", remoteThreadId: null, state: "lost" }),
    ],
    watches: [],
    limit: 10,
  }).launches;
  assert.deepStrictEqual(
    launches.map((launch) => [launch.threadId, launch.hostUnavailableSince, launch.dismissable]),
    [
      [ThreadId.make("away"), since, true],
      [ThreadId.make("answering"), null, false],
      [ThreadId.make("ended"), since, true],
      [null, null, false],
    ],
  );
});

it("a dismissed record never hides a sibling that is still followed", () => {
  const [launch] = Catalog.mergeRemoteLaunches({
    dispatches: [
      dispatch({
        correlationId: "newer",
        state: "cancelled",
        endReason: "dismissed",
        endedAt: "2026-10-12T12:00:00.000Z",
        updatedAt: "2026-10-12T12:00:00.000Z",
      }),
      dispatch({ correlationId: "older", originThreadId: otherLauncher }),
    ],
    watches: [],
    limit: 10,
  }).launches;
  assert.strictEqual(launch?.state, "running");
  assert.strictEqual(launch?.launcherThreadId, otherLauncher);
  assert.strictEqual(launch?.dismissedAt, null);
});

it("a thread whose only record was dismissed shows when it was dismissed", () => {
  const [launch] = Catalog.mergeRemoteLaunches({
    dispatches: [
      dispatch({ state: "cancelled", endReason: "dismissed", endedAt: "2026-10-12T12:00:00.000Z" }),
    ],
    watches: [],
    limit: 10,
  }).launches;
  assert.strictEqual(launch?.dismissedAt, "2026-10-12T12:00:00.000Z");
  assert.strictEqual(launch?.dismissable, false);
});

it("a watch whose host stopped answering can be dismissed; one that answers cannot", () => {
  const away = ThreadId.make("away");
  const launches = Catalog.mergeRemoteLaunches({
    dispatches: [],
    watches: [
      watch(
        { host: "laptop", threadId: away, updatedAt: "2026-10-12T12:00:00.000Z" },
        { outage: outage("2026-10-12T11:00:00.000Z") },
      ),
      watch({ host: "laptop", updatedAt: "2026-10-12T11:00:00.000Z" }),
    ],
    limit: 10,
  }).launches;
  assert.deepStrictEqual(
    launches.map((launch) => [launch.threadId, launch.dismissable]),
    [
      [away, true],
      [remote, false],
    ],
  );
});

it.effect("a shown thread counts every one of its records, also those past the page", () =>
  Effect.gen(function* () {
    const requestedKeys: Array<ReadonlyArray<string>> = [];
    const layer = Catalog.layerWithoutDependencies.pipe(
      Layer.provide(
        Layer.mock(Coordinator.RemoteDispatchCoordinator)({
          // The page holds only the newer, dismissed record of the thread.
          listRecent: () =>
            Effect.succeed([
              dispatch({
                correlationId: "newer",
                state: "cancelled",
                endReason: "dismissed",
                endedAt: "2026-10-12T12:00:00.000Z",
                updatedAt: "2026-10-12T12:00:00.000Z",
              }),
            ]),
          listForRemoteThreads: (keys) => {
            requestedKeys.push(keys);
            return Effect.succeed([
              dispatch({
                correlationId: "newer",
                state: "cancelled",
                endReason: "dismissed",
                endedAt: "2026-10-12T12:00:00.000Z",
                updatedAt: "2026-10-12T12:00:00.000Z",
              }),
              dispatch({
                correlationId: "older",
                hostUnavailableSince: "2026-10-12T09:30:00.000Z",
              }),
            ]);
          },
        }),
      ),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({ listRemote: () => Effect.succeed([]) }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const catalog = yield* Catalog.RemoteLaunchCatalog;
      return yield* catalog.list({ limit: 1 });
    }).pipe(Effect.provide(layer));
    assert.deepStrictEqual(requestedKeys, [["builder\u001fremote"]]);
    assert.strictEqual(result.launches[0]?.state, "running");
    assert.strictEqual(result.launches[0]?.dismissable, true);
  }),
);

it.effect(
  "dismissing removes the outage watches of every launcher for that thread and nothing else",
  () =>
    Effect.gen(function* () {
      const unwatched: Array<[ThreadId, string]> = [];
      const layer = Catalog.layerWithoutDependencies.pipe(
        Layer.provide(
          Layer.mock(Coordinator.RemoteDispatchCoordinator)({
            dismiss: (selector) => {
              assert.deepStrictEqual(selector, { host: "builder", remoteThreadId: remote });
              return Effect.succeed([dispatch()]);
            },
          }),
        ),
        Layer.provide(
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            listRemote: () =>
              Effect.succeed([
                watch(
                  { host: "builder", updatedAt: "2026-10-12T12:00:00.000Z" },
                  { outage: outage("2026-10-12T11:00:00.000Z") },
                ),
                watch(
                  {
                    host: "builder",
                    launcherThreadId: otherLauncher,
                    updatedAt: "2026-10-12T12:00:00.000Z",
                  },
                  { outage: outage("2026-10-12T11:00:00.000Z"), incarnation: "second" },
                ),
                // Its host answers: kept.
                watch({
                  host: "builder",
                  launcherThreadId: ThreadId.make("third"),
                  updatedAt: "2026-10-12T12:00:00.000Z",
                }),
                // Another thread on the same host: kept.
                watch(
                  {
                    host: "builder",
                    threadId: ThreadId.make("other"),
                    updatedAt: "2026-10-12T12:00:00.000Z",
                  },
                  { outage: outage("2026-10-12T11:00:00.000Z") },
                ),
              ]),
            unwatch: (target, only) => {
              unwatched.push([target.launcherThreadId, only?.incarnation ?? "none"]);
              return Effect.succeed(true);
            },
          }),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const catalog = yield* Catalog.RemoteLaunchCatalog;
        return yield* catalog.dismiss({ host: "builder", threadId: remote });
      }).pipe(Effect.provide(layer));
      assert.deepStrictEqual(result, { dispatches: 1, watches: 2 });
      assert.deepStrictEqual(unwatched, [
        [launcher, "incarnation"],
        [otherLauncher, "second"],
      ]);
    }),
);
