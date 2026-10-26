import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";

it.effect("thread read exposes run cause", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:mcp-run-cause");
    const runId = RunId.make("run:mcp-run-cause");
    const shell = {
      ...liveThreadShell(threadId),
      latestRunId: runId,
      status: "cancelled" as const,
    };
    const target = idleThreadProjection(shell);
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      status: "cancelled",
      terminationCause: { kind: "provider_process_exit" },
      modelSelection: shell.modelSelection,
      requestedAt: DateTime.makeUnsafe("2026-10-15T00:00:00Z"),
      startedAt: null,
      completedAt: DateTime.makeUnsafe("2026-10-15T00:00:01Z"),
    } as OrchestrationV2ThreadProjection["runs"][number];
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:mcp-run-cause"),
      requestNamespace: "client:mcp-run-cause",
      thread: undefined,
      client: { sessionId: "run-cause", label: "test", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerSettings.layerTest(),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getProjectThreadRecords: () => Effect.succeed({ ...target, runs: [run] }),
        getTimelinePage: () => Effect.succeed({ items: [], totalItems: 0, hasMore: false }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    const read = yield* Effect.gen(function* () {
      return yield* (yield* OrchestratorMcpService.OrchestratorMcpService).readThread(scope, {
        threadId,
      });
    }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
    assert.equal(read.recentRuns[0]?.terminationCause?.kind, "provider_process_exit");
  }),
);
