import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import { newLaunchWatch } from "./launchWatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const threadId = ThreadId.make("caller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("host-threads-watch-test"),
  requestNamespace: "thread:caller",
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const remoteWatchRead = {
  thread: {
    threadId: "remote-1",
    projectId: "remote-project",
    title: "Remote work",
    createdBy: "agent",
    creationSource: "mcp",
    status: "running",
    latestRunId: "run-1",
    activeRunId: "run-1",
    providerInstanceId: "codex",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    linkedPullRequest: null,
    titleRegeneration: null,
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    relationshipToParent: null,
    runCount: 1,
    itemCount: 0,
    pendingRequestCount: 0,
    archived: false,
    settled: false,
    settledAt: null,
    snoozed: false,
    snoozedUntil: null,
    createdAt: "2026-10-13T01:00:00.000Z",
    updatedAt: "2026-10-13T01:00:00.000Z",
  },
  recentRuns: [],
  items: [],
  nextPosition: null,
  hasMore: false,
};

const watchScope = (grants: ReadonlyArray<AuthEnvironmentScope>, readOnly = false) => {
  const requested: string[] = [];
  const invocation: McpInvocationScope = {
    ...scope,
    readOnly,
    grantedScopes: grants,
    reauthorize: (required) => {
      requested.push(...required);
      const missing = required.find((requiredScope) => !grants.includes(requiredScope));
      return missing === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              message: `Missing ${missing}`,
              requiredScope: missing,
            }),
          );
    },
  };
  return { invocation, requested };
};

const runService = <A, E>(
  options: {
    readonly interactionMode: "default" | "plan";
    readonly runtimeMode?: "full-access" | "approval-required";
    readonly hostCall: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  },
  body: (service: HostThreadsMcpService.HostThreadsMcpServiceShape) => Effect.Effect<A, E>,
) => {
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const registrations: Array<
    Parameters<LaunchWatchService.LaunchWatchServiceShape["register"]>[0]
  > = [];
  const layer = HostThreadsMcpService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadResultService.ThreadResultService)({
        forRun: () => Effect.succeed(null as never),
      }),
    ),
    Layer.provide(Layer.mock(RemoteReportService.RemoteReportService)({})),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        find: () => Effect.succeed(null),
        register: (input) =>
          Effect.sync(() => {
            registrations.push(input);
            return {
              ...newLaunchWatch({
                launcherThreadId: input.launcherThreadId,
                host: input.host ?? null,
                threadId: input.threadId,
                projectId: input.projectId,
                title: input.title,
                incarnation: "test",
                notifyWebhook: false,
                now: 1_000,
              }),
              ...(input.checkpointReplication === undefined
                ? {}
                : { checkpointReplication: input.checkpointReplication }),
            };
          }),
      }).pipe(
        Layer.provideMerge(
          Layer.mock(ThreadReplicaService.ThreadReplicaService)({
            capture: (_input, authorize) =>
              authorize.pipe(
                Effect.as({ status: "skipped" as const, reason: "capture_failed" as const }),
              ),
          }),
        ),
      ),
    ),
    Layer.provide(
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        isTaskThread: () => Effect.succeed(false),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        readThread: () => Effect.succeed(remoteWatchRead as never),
      }),
    ),
    Layer.provide(layerNoFleetSync),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        resolveThreadEnvironment: () => Effect.succeed(null),
        callHostTool: (call, authorize) => {
          calls.push(call);
          return authorize.pipe(Effect.andThen(options.hostCall(call)));
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            runtimeMode: options.runtimeMode ?? "full-access",
            interactionMode: options.interactionMode,
            archivedAt: null,
            deletedAt: null,
            activeRunId: "run-1",
            providerInstanceId,
          } as never),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* HostThreadsMcpService.HostThreadsMcpService;
    const result = yield* body(service).pipe(Effect.result);
    return { result, calls, registrations };
  }).pipe(Effect.provide(layer));
};

it.effect("watches a linked-host thread with a writable caller's orchestration:read grant", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope(["orchestration:read"]);
    const { result, calls, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) =>
        service.watchThread(invocation, { host: "box", threadId: ThreadId.make("remote-1") }),
    );
    expect(result._tag).toBe("Success");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: "box", tool: "goat_thread_read", writes: false });
    expect(calls[0]?.arguments).not.toHaveProperty("host");
    expect(registrations).toMatchObject([
      {
        launcherThreadId: threadId,
        host: "box",
        threadId: "remote-1",
        runId: "run-1",
        checkpointReplication: "off",
        replicaCeiling: "full-access",
      },
    ]);
    expect(requested).toEqual(["orchestration:operate", "orchestration:read"]);
  }),
);

it.effect("a read-grant watch cannot capture a checkpoint", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope(["orchestration:read"]);
    const { result, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) =>
        Effect.gen(function* () {
          yield* service.watchThread(invocation, {
            host: "box",
            threadId: ThreadId.make("remote-1"),
          });
          return yield* service.captureCheckpoint(invocation, {
            threadId: ThreadId.make("remote-1"),
            runId: RunId.make("run-1"),
          });
        }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
    expect(registrations[0]?.checkpointReplication).toBe("off");
    expect(requested).toEqual([
      "orchestration:operate",
      "orchestration:read",
      "orchestration:operate",
    ]);
  }),
);

it.effect.each([
  { interactionMode: "default", runtimeMode: "full-access", allowed: true },
  { interactionMode: "plan", runtimeMode: "full-access", allowed: false },
  { interactionMode: "default", runtimeMode: "approval-required", allowed: false },
] as const)("allows checkpoint replication only with full-access default caller: %j", (testCase) =>
  Effect.gen(function* () {
    const { invocation } = watchScope(["orchestration:read", "orchestration:operate"]);
    const { result, registrations } = yield* runService(
      {
        interactionMode: testCase.interactionMode,
        runtimeMode: testCase.runtimeMode,
        hostCall: () => Effect.succeed(remoteWatchRead),
      },
      (service) =>
        service.watchThread(invocation, {
          host: "box",
          threadId: ThreadId.make("remote-1"),
          checkpointReplication: "on",
        }),
    );
    expect(result._tag).toBe(testCase.allowed ? "Success" : "Failure");
    expect(registrations).toHaveLength(testCase.allowed ? 1 : 0);
    if (testCase.allowed) expect(registrations[0]?.checkpointReplication).toBe("on");
    else if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
  }),
);

it.effect("refuses explicit checkpoint replication without orchestration:operate", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope(["orchestration:read"]);
    const { result, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) =>
        service.watchThread(invocation, {
          host: "box",
          threadId: ThreadId.make("remote-1"),
          checkpointReplication: "on",
        }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
    expect(registrations).toHaveLength(0);
    expect(requested).toEqual(["orchestration:operate"]);
  }),
);

it.effect("preserves host checkpoint replication inheritance with orchestration:operate", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope(["orchestration:operate"]);
    const { result, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) =>
        service.watchThread(invocation, { host: "box", threadId: ThreadId.make("remote-1") }),
    );
    expect(result._tag).toBe("Success");
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).not.toHaveProperty("checkpointReplication");
    expect(requested).toEqual(["orchestration:operate"]);
  }),
);

it.effect("refuses watches from a read-only provider even when orchestration:read is granted", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope(["orchestration:read"], true);
    const { result, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) =>
        service.watchThread(invocation, { host: "box", threadId: ThreadId.make("remote-1") }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
    expect(registrations).toHaveLength(0);
    expect(requested).toEqual(["orchestration:operate"]);
  }),
);

it.effect("refuses watch when the calling thread loses orchestration:read", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope([]);
    const { result, calls, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) =>
        service.watchThread(invocation, { host: "box", threadId: ThreadId.make("remote-1") }),
    );
    expect(calls).toHaveLength(1);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
    expect(registrations).toHaveLength(0);
    expect(requested).toEqual(["orchestration:operate", "orchestration:read"]);
  }),
);

it.effect("refuses a local watch without orchestration:operate", () =>
  Effect.gen(function* () {
    const { invocation, requested } = watchScope(["orchestration:read"]);
    const { result, calls, registrations } = yield* runService(
      { interactionMode: "default", hostCall: () => Effect.succeed(remoteWatchRead) },
      (service) => service.watchThread(invocation, { threadId: ThreadId.make("remote-1") }),
    );
    expect(calls).toHaveLength(0);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
    expect(registrations).toHaveLength(0);
    expect(requested).toEqual(["orchestration:operate"]);
  }),
);
