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
    assert.deepStrictEqual(requestedWatchLimits, [2]);
    assert.strictEqual(result.launches.length, 1);
    assert.strictEqual(result.truncated, false);
  }),
);
