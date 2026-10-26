import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerNoFleetSync } from "../../../goatclaw/FleetSync.testkit.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
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
  client: { sessionId: "session-1", label: "Claude Code", access: "full-access" },
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
  ({ id, threadId, lastRunStatus, runCount: 1, nextRunAt: null }) as never;

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
      taskId: "task-unbound",
      threadId: "launched-thread",
      lastRunStatus: "succeeded",
    });
    const failed = yield* run("task-bound");
    expect(failed.structuredContent).toMatchObject({
      taskId: "task-bound",
      threadId: null,
      lastRunStatus: "failed",
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
        Layer.provide(layerNoFleetSync),
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
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
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
        Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({ connectedHosts: Effect.succeed([]) }),
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
      ),
    ),
  ),
);
