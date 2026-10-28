import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, NodeId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";

it.effect.each(["run-a", "run-b", undefined])(
  "delegation requires authenticated run %s to match the active parent; preserves callers without a run",
  (callerRun) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("goat-bot-session:delegate:1");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const parent = {
        ...idleThreadProjection(liveThreadShell(threadId)),
        runs: [
          {
            id: RunId.make("run-b"),
            ordinal: 2,
            status: "running",
            rootNodeId: NodeId.make("root-b"),
            providerInstanceId,
          },
        ] as never,
      };
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("fixture"),
        requestNamespace: "credential-a",
        issuedAt: 0,
        capabilities: new Set(["orchestration"]),
        client: undefined,
        thread: {
          threadId,
          providerInstanceId,
          providerSessionId: "credential-a",
          ...(callerRun === undefined ? {} : { runId: RunId.make(callerRun) }),
        },
      };
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        layerNoFleetSync,
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parent),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
      );
      const failure = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service
          .delegateTask(scope, { task: "Review", target: { host: "box" } })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(dependencies))));
      expect(failure.code).toBe(callerRun === "run-a" ? "parent_not_active" : "invalid_request");
    }),
);
