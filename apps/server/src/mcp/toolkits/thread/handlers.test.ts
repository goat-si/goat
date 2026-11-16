import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { McpSchema, McpServer } from "effect/ai";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Access from "../../McpToolAccess.ts";
import { ThreadToolkit } from "./tools.ts";
import * as Handlers from "./handlers.ts";

import { layerNoFleetSync } from "../../../goatclaw/FleetSync.testkit.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerThreadStartMocks } from "../../threadStartMocks.testkit.ts";
import type * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as AnalyticsService from "../../../telemetry/AnalyticsService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ThreadReplicaService from "../../ThreadReplicaService.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-thread-environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: {
    sessionId: "session-1",
    label: "Claude Code",
    access: "full-access",
    webOrigin: "https://box.example.ts.net",
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-thread", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-thread", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// The handler reads only these fields of a stored task.
const task = (id: string, threadId: string | null, lastRunStatus: "succeeded" | "failed") =>
  ({
    id,
    title: "Nightly review",
    threadId,
    lastRunStatus,
    runCount: 1,
    nextRunAt: null,
    lastRun: {
      firingId: "firing",
      dispatchStatus: "accepted",
      status: "queued",
      threadId: "launched-thread",
      runId: "exact-run",
      requestedAt: "2026-10-15T00:00:00.000Z",
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
    },
  }) as never;

const layerThreadToolsWith = (
  threads: Layer.Layer<ThreadManagement.ThreadManagementService>,
  extra: Layer.Layer<never> = Layer.empty,
) =>
  McpHttpServer.layerThreadToolkit.pipe(
    Layer.provide(extra),
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provide(layerNoFleetSync),
    Layer.provide(layerThreadStartMocks),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        find: () => Effect.succeed(null),
      }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
    ),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(ThreadSearch.ThreadSearch)({
        matchThreads: () =>
          Effect.succeed([
            {
              threadId: ThreadId.make("searched-thread"),
              projectId: ProjectId.make("project-search"),
              projectTitle: "Search",
              title: "Fix flaky test",
              source: "title" as const,
              snippet: "Fix flaky test",
              messageCreatedAt: null,
            },
          ]),
      }),
    ),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(threads),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        connectedHosts: Effect.succeed([]),
        // The studio host answers a search with a link on its own web origin.
        callHostTool: (_call, authorize) =>
          authorize.pipe(
            Effect.as({
              matches: [
                {
                  threadId: "studio-thread",
                  projectId: "project-studio",
                  projectTitle: "Studio",
                  title: "Fix flaky test on studio",
                  status: "completed",
                  updatedAt: "2026-10-15T00:00:00.000Z",
                  archived: false,
                  source: "title",
                  snippet: "Fix flaky test on studio",
                  messageCreatedAt: null,
                  link: "[Fix flaky test on studio](https://studio.example.ts.net/studio-environment/studio-thread)",
                },
              ],
              nextCursor: null,
              truncated: false,
            }),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () =>
          Effect.succeed({
            tasks: [
              task("task-unbound", null, "succeeded"),
              task("task-bound", "bound-thread", "failed"),
            ],
          }),
        // The bound task's dispatch failed; the unbound one launched a fresh thread.
        runNow: (input) =>
          Effect.succeed(
            input.id === "task-unbound"
              ? {
                  task: task(input.id, null, "succeeded"),
                  threadId: "launched-thread" as never,
                }
              : { task: task(input.id, "bound-thread", "failed"), threadId: null },
          ),
      }),
    ),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  );
const layerThreadTools = layerThreadToolsWith(
  Layer.mock(ThreadManagement.ThreadManagementService)({
    listProjectThreads: () =>
      Effect.succeed([
        {
          id: ThreadId.make("searched-thread"),
          title: "Fix flaky test",
          status: "idle",
          updatedAt: DateTime.makeUnsafe("2026-10-15T00:00:00.000Z"),
          archivedAt: null,
        } as never,
      ]),
  }),
);

const callerScope: McpInvocationContext.McpInvocationScope = {
  ...scope,
  client: undefined,
  thread: {
    threadId: ThreadId.make("own"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

// A thread read whose runs or messages are bounded by nothing but the thread.
const historyReads = (reads: Array<string>) => {
  const record = (
    fields: ReadonlyArray<string>,
    filter: ProjectionStore.ProjectionRecordFilter | undefined,
  ) => {
    if (
      fields.includes("runs") &&
      filter?.runIds === undefined &&
      filter?.runStatuses === undefined
    )
      reads.push("every run");
    if (
      fields.includes("messages") &&
      filter?.messageIds === undefined &&
      filter?.messageRunIds === undefined
    )
      reads.push("every message");
  };
  const projection = McpToolAccessTestkit.idleThreadProjection(
    McpToolAccessTestkit.liveThreadShell(ThreadId.make("own")),
  );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(McpToolAccessTestkit.liveThreadShell(id)),
    getProjectThreadRecords: (_target, fields, filter) =>
      Effect.sync(() => record(fields, filter)).pipe(Effect.as(projection as never)),
    getThreadRecords: (_id, fields, filter) =>
      Effect.sync(() => record(fields, filter)).pipe(Effect.as(projection as never)),
    getMessagesById: () => Effect.succeed(new Map()),
    dispatch: () => Effect.succeed({ sequence: 1 } as never),
  });
};

const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect(
  "goat_queue_list and goat_queue_read load only the queued runs and their messages",
  () => {
    const reads: Array<string> = [];
    return Effect.gen(function* () {
      yield* callTool("goat_queue_list", {});
      yield* callTool("goat_queue_read", { queuedRunId: "run:queued" });
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(layerThreadToolsWith(historyReads(reads))));
  },
);

it.effect("handoff analytics read only the caller's active run and its message", () => {
  const reads: Array<string> = [];
  const recorded = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    yield* callTool("goat_queue_edit", { queuedRunId: "run:queued", text: "Edited" });
    yield* Deferred.await(recorded);
    expect(reads).toEqual([]);
  }).pipe(
    Effect.provide(
      layerThreadToolsWith(
        historyReads(reads),
        Layer.mergeAll(
          Layer.succeed(
            AnalyticsService.AnalyticsService,
            AnalyticsService.AnalyticsService.of({
              record: () => Deferred.succeed(recorded, undefined).pipe(Effect.asVoid),
              flush: Effect.void,
              recordOwners: () => Effect.void,
            }),
          ),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        ),
      ),
    ),
  );
});

it.effect("goat_schedule_run reports the thread the run dispatched to, not the binding", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const run = (taskId: string) =>
      server
        .callTool({ name: "goat_schedule_run", arguments: { taskId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    // A task without a binding launches a fresh thread on every run.
    const launched = yield* run("task-unbound");
    expect(launched.structuredContent).toMatchObject({
      lastRun: { firingId: "firing", runId: "exact-run", status: "queued" },
      taskId: "task-unbound",
      threadId: "launched-thread",
      // regression: B11-R1-01 an outside client got no thread link it could open
      link: "[Nightly review](https://box.example.ts.net/mcp-thread-environment/launched-thread)",
      lastRunStatus: "succeeded",
    });
    const failed = yield* run("task-bound");
    expect(failed.structuredContent).toMatchObject({
      taskId: "task-bound",
      threadId: null,
      lastRunStatus: "failed",
    });
    expect(failed.structuredContent).not.toHaveProperty("link");
  }).pipe(Effect.provide(layerThreadTools)),
);

// regression: B11-R1-01 search matches on this host had no link an outside client could open
it.effect("goat_thread_search links this host's matches on the origin the client reached", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const found = yield* server
      .callTool({ name: "goat_thread_search", arguments: { query: "flaky" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(found.structuredContent).toMatchObject({
      matches: [
        {
          threadId: "searched-thread",
          link: "[Fix flaky test](https://box.example.ts.net/mcp-thread-environment/searched-thread)",
        },
      ],
    });
  }).pipe(Effect.provide(layerThreadTools)),
);

// regression: #2333 a host's match lost the link that host returned
it.effect("goat_thread_search keeps the link another host returned for its match", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const found = yield* server
      .callTool({ name: "goat_thread_search", arguments: { query: "flaky", host: "studio" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(found.structuredContent).toMatchObject({
      matches: [
        {
          host: "studio",
          threadId: "studio-thread",
          link: "[Fix flaky test on studio](https://studio.example.ts.net/studio-environment/studio-thread)",
        },
      ],
    });
  }).pipe(Effect.provide(layerThreadTools)),
);

it.effect.each(["run_mismatch", "storage"] as const)(
  "maps report %s to the existing MCP error code",
  (reason) =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit.pipe(
        Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
      );
      const response = yield* toolkit
        .handle("goat_thread_report_result", { runId: RunId.make("foreign"), outcome: "succeeded" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(response.at(-1)?.result).toMatchObject({
        code: reason === "run_mismatch" ? "invalid_request" : "orchestration_error",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpToolAccessTestkit.layerPermissionProfilesOff,
          McpToolAccessTestkit.liveThreadsLayer,
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            ...scope,
            client: undefined,
            thread: {
              threadId: ThreadId.make("own"),
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          }),
          Layer.mock(ThreadResultService.ThreadResultService)({
            report: () => Effect.fail(new ThreadResultService.ThreadResultError({ reason })),
          }),
        ),
      ),
    ),
);

it.effect.each(["user", "agent"] as const)(
  "goat_queue_edit puts a slash command only into an agent's own queued message (%s)",
  (author) => {
    const own = ThreadId.make("own");
    const queuedRunId = RunId.make("run:queued");
    const dispatched: Array<unknown> = [];
    const projection = {
      ...McpToolAccessTestkit.idleThreadProjection(McpToolAccessTestkit.liveThreadShell(own)),
      runs: [{ id: queuedRunId, status: "queued", userMessageId: "message:queued" }],
      messages: [{ id: "message:queued", createdBy: author, text: "run the tests" }],
    } as never;
    return Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit.pipe(
        Effect.provide(Access.HandlersLayer.layer(Handlers.layer)),
      );
      const response = yield* toolkit
        .handle("goat_queue_edit", { queuedRunId, text: "/logout" })
        .pipe(Stream.unwrap, Stream.runCollect);
      if (author === "user") {
        expect(response.at(-1)?.result).toMatchObject({ code: "capability_denied" });
        expect(dispatched).toHaveLength(0);
      } else {
        expect(dispatched).toMatchObject([{ type: "queued-run.edit", text: "/logout" }]);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpToolAccessTestkit.layerPermissionProfilesOff,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(McpToolAccessTestkit.liveThreadShell(threadId)),
            getThreadRecords: () => Effect.succeed(projection),
            getProjectThreadRecords: () => Effect.succeed(projection),
            getMessagesById: () =>
              Effect.succeed(new Map([["message:queued", { createdBy: author }]]) as never),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: 1 } as never;
              }),
          }),
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            ...scope,
            client: undefined,
            thread: {
              threadId: own,
              providerSessionId: "session",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          }),
          Layer.mock(ThreadResultService.ThreadResultService)({}),
          NodeCrypto.layer,
        ),
      ),
    );
  },
);
