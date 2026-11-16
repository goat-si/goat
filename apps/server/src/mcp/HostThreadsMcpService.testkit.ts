import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import { BUILTIN_PERMISSION_PROFILES } from "@goat/contracts";
import * as FleetSync from "../goatclaw/FleetSync.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import { expect } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestratorMcpCloudTask,
  type OrchestratorMcpThreadReadResult,
  RunId,
  type OrchestratorMcpThreadListResult,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import type { LaunchWatch } from "./launchWatch.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { item } from "./hostThreadsList.testkit.ts";

export const threadId = ThreadId.make("caller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("host-threads-test"),
  requestNamespace: "thread:caller",
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const localList: OrchestratorMcpThreadListResult = {
  projectId: null,
  currentThreadId: threadId,
  threads: [item("local-1", "2026-10-11T10:00:00.000Z")],
  nextCursor: null,
  total: 1,
};

export const remoteStop = { state: "unresponsive", since: "2026-10-13T01:05:00.000Z" } as const;
export const remoteCloudTask: OrchestratorMcpCloudTask = {
  taskId: "host-cloud-task",
  status: "running",
  tracking: "link-only",
  url: "https://example.com/tasks/host",
  localChangesExcluded: true,
  updatedAt: "2026-10-13T01:00:00.000Z",
};

/** The service over fakes: `hostCall` answers each remote call after running its authorization. */
export const runService = <A, E>(
  options: {
    readonly interactionMode: "default" | "plan";
    readonly goatclawEnabled?: boolean;
    /** What goatclaw fleet sync reports for the destination; absent leaves the service out. */
    readonly fleetReach?: FleetSync.HostReach;
    readonly onSettle?: (sent: boolean) => void;
    readonly taskThread?: boolean;
    readonly reviewFinished?: boolean | (() => boolean);
    readonly relayReceipt?: {
      readonly clientRequestId: string;
      readonly sequence: number;
      readonly originLabel: string;
    };
    readonly taskOwner?: ThreadId;
    readonly onResume?: (host: string, id: string) => void;
    readonly hosts?: ReadonlyArray<string>;
    /** The machine the caller was launched from, when it has a report binding. */
    readonly originLabel?: string;
    /** That machine declared at launch that it delivers sends for this one. */
    readonly relaySend?: boolean;
    /** The caller's launch watch that find returns. */
    readonly watch?: LaunchWatch;
    readonly localRead?: OrchestratorMcpThreadReadResult;
    readonly onResult?: (id: ThreadId, runId: RunId | null | undefined) => void;
    readonly hostCall: (
      call: SshRemoteDispatch.SshHostToolCall,
    ) => Effect.Effect<unknown, SshRemoteDispatch.SshRemoteDispatchError>;
  },
  body: (service: HostThreadsMcpService.HostThreadsMcpServiceShape) => Effect.Effect<A, E>,
) => {
  const fleetReach = options.fleetReach;
  const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
  const relays: Array<unknown> = [];
  const rearms: Array<Parameters<LaunchWatchService.LaunchWatchServiceShape["rearm"]>[0]> = [];
  const layer = HostThreadsMcpService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadResultService.ThreadResultService)({
        forRun: (id, runId) =>
          Effect.sync(() => {
            options.onResult?.(id, runId);
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(RemoteReportService.RemoteReportService)({
        origin: () =>
          Effect.succeed(
            options.originLabel === undefined
              ? null
              : {
                  originLabel: options.originLabel,
                  originThreadId: ThreadId.make("origin"),
                  relaySend: options.relaySend ?? false,
                },
          ),
        relayReceipt: (_threadId, clientRequestId) =>
          Effect.succeed(
            options.relayReceipt?.clientRequestId === clientRequestId
              ? {
                  sequence: options.relayReceipt.sequence,
                  originLabel: options.relayReceipt.originLabel,
                }
              : null,
          ),
        relay: (_threadId, input) =>
          Effect.sync(() => {
            relays.push(input);
            return { sequence: 1 };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({
        rearm: (input) => Effect.sync(() => void rearms.push(input)),
        find: () => Effect.succeed(options.watch ?? null),
      }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
    ),
    Layer.provide(
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        taskOrigin: () => Effect.succeed(options.taskOwner ?? threadId),
        isTaskThread: () => Effect.succeed(options.taskThread ?? false),
        resume: (host, id) => Effect.sync(() => options.onResume?.(host, id)),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        admitRemoteSend: () =>
          Effect.succeed({
            ceiling:
              options.goatclawEnabled === true ? BUILTIN_PERMISSION_PROFILES.worker : undefined,
            settle: (sent: boolean) => Effect.sync(() => options.onSettle?.(sent)),
          }),
        listThreads: () => Effect.succeed(localList),
        readThread: () =>
          options.localRead === undefined
            ? Effect.die("unused local read")
            : Effect.succeed(options.localRead),
      }),
    ),
    Layer.provide(
      fleetReach === undefined
        ? layerNoFleetSync
        : Layer.mock(FleetSync.GoatclawFleetSync)({
            ensure: () => Effect.succeed(fleetReach),
          }),
    ),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        connectedHosts: Effect.succeed(options.hosts ?? []),
        callHostTool: (call, authorize) => {
          calls.push(call);
          return authorize.pipe(Effect.andThen(options.hostCall(call)));
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        assertReviewTaskSendAllowed: (input) => {
          if (options.taskOwner !== undefined) expect(input.senderThreadId).toBe(options.taskOwner);
          return (
            typeof options.reviewFinished === "function"
              ? options.reviewFinished()
              : options.reviewFinished
          )
            ? Effect.fail(
                new ThreadManagementService.ThreadManagementReviewTaskFinishedError({
                  threadId: input.threadId,
                }),
              )
            : Effect.void;
        },
        getThreadShell: () =>
          Effect.succeed({
            id: threadId,
            runtimeMode: "full-access",
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
    return { result, calls, rearms, relays };
  }).pipe(Effect.provide(layer));
};

export const unknownHost = new SshRemoteDispatch.SshRemoteDispatchError({
  reason: "host_unknown",
  message: "juns-macbook-pro is not in this machine's SSH config or known_hosts.",
});
