import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { layerPermissionProfilesOff } from "./McpToolAccess.testkit.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "provider-list-host", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "provider-list-host", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const remoteCatalog = {
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      models: [{ id: "remote-only-model" }],
      canRunChildTask: true,
      canRunCrossProviderChildTask: true,
      constraints: [],
    },
  ],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 8,
  },
};

it.effect("provider.list with host lists that machine's models, not this one's", () =>
  Effect.gen(function* () {
    const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
    const layer = McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(layerPermissionProfilesOff),
      Layer.provide(layerNoFleetSync),
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          find: () => Effect.succeed(null),
        }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      // The local catalog is empty, so any model in the answer came from the host.
      Layer.provide(ProviderRegistryMock.layer([])),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  calls.push(call);
                  return remoteCatalog;
                }),
              ),
            ),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool({ name: "goat_provider_list", arguments: { host: "box", search: "remote" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("host-catalog"),
            requestNamespace: "client",
            thread: undefined,
            client: { sessionId: "client", label: "Outside", access: "full-access" },
            issuedAt: 0,
            capabilities: new Set(["orchestration"] as const),
          }),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        host: "box",
        providers: [{ providerInstanceId: "codex", models: [{ id: "remote-only-model" }] }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ tool: "orchestrator_capabilities", writes: false });
      expect(calls[0]?.arguments).toEqual({ search: "remote" });
    }).pipe(Effect.provide(layer));
  }),
);
