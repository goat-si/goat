import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, NodeId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Schedules from "../scheduledTasks/ScheduledTaskService.ts";
import * as Settings from "../serverSettings.ts";
import * as Remote from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

it.effect("missing delegated task errors list open tasks for status and cancellation", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:parent");
    const taskId = NodeId.make("node:open");
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:test"),
      requestNamespace: "test",
      thread: {
        threadId,
        providerSessionId: "test",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const layer = layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: (_id, _fields, filter) =>
              Effect.succeed({
                subagents: filter?.subagentIds
                  ? []
                  : [
                      {
                        id: taskId,
                        threadId,
                        origin: "app_owned",
                        childThreadId: ThreadId.make("thread:child"),
                        title: "Review",
                        status: "running",
                      },
                    ],
              } as never),
          }),
          NodeCrypto.layer,
          Settings.layerTest(),
          Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(Projects.ProjectService)({}),
          Layer.mock(Secrets.SecretRequests)({}),
          Layer.mock(Schedules.ScheduledTaskService)({}),
          Layer.mock(Remote.RemoteDispatchCoordinator)({}),
          Layer.mock(Ssh.SshRemoteDispatch)({}),
        ),
      ),
    );
    const service = yield* Mcp.OrchestratorMcpService.pipe(Effect.provide(layer));
    const missing = NodeId.make("node:missing");
    const errors = [
      yield* service.taskStatus(scope, missing).pipe(Effect.flip),
      yield* service.cancelTask(scope, { taskId: missing }).pipe(Effect.flip),
    ];
    for (const error of errors) {
      expect(error.code).toBe("task_not_found");
      expect(error.message).toContain("node:open (Review)");
    }
  }),
);
