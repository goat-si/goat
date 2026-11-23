import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";

it.effect("tells the parent to end its turn only while its task still runs", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:mcp-next-parent");
    const childThreadId = ThreadId.make("thread:mcp-next-child");
    const taskId = NodeId.make("node:mcp-next-task");
    let finished = false;
    let pendingRequest: "live" | "message" | null = null;
    const parentProjection = () =>
      ({
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: finished ? "completed" : "running",
            result: finished ? "done" : null,
            completionDelivery: { state: "pending" },
          },
        ],
      }) as unknown as OrchestrationV2ThreadProjection;
    const childRun = () => ({
      id: RunId.make("run:mcp-next-child"),
      ordinal: 1,
      status: finished ? ("completed" as const) : ("running" as const),
      delegatedTaskId: taskId,
    });
    const childProjection = () =>
      ({
        thread: { id: childThreadId, title: "Child task" },
        runs: [childRun()],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests:
          pendingRequest === null
            ? []
            : [
                {
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: pendingRequest },
                },
              ],
        nodes: [],
        turnItems: [],
      }) as unknown as OrchestrationV2ThreadProjection;
    const layerDependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Effect.succeed(threadId === parentThreadId ? parentProjection() : childProjection()),
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
        getProjectThreadRecords: () => Effect.succeed(childProjection()),
        waitForThread: () =>
          Effect.succeed({
            threadId: childThreadId,
            run: childRun() as unknown as OrchestrationV2ThreadProjection["runs"][number],
            timedOut: !finished,
          }),
        dispatch: () => Effect.succeed({} as never),
      }),
      ServerSettings.layerTest(),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        list: () => Effect.succeed([]),
      }),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    const scope: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:mcp-next"),
      requestNamespace: "provider-session:mcp-next",
      thread: {
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-next",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };

    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const running = yield* service.taskStatus(scope, taskId);
      assert.equal(running.status, "running");
      assert.equal(running.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
      const waiting = yield* service.waitForThread(scope, { threadId: childThreadId });
      assert.isTrue(waiting.timedOut);
      assert.equal(waiting.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

      // A child waiting on a question or approval needs an answer, not a wake.
      pendingRequest = "live";
      const asking = yield* service.waitForThread(scope, { threadId: childThreadId });
      assert.isTrue(asking.timedOut);
      assert.notProperty(asking, "next");

      // A question answered by message does not stop the child.
      pendingRequest = "message";
      const working = yield* service.waitForThread(scope, { threadId: childThreadId });
      assert.equal(working.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
      pendingRequest = null;

      finished = true;
      const completed = yield* service.taskStatus(scope, taskId);
      assert.equal(completed.status, "completed");
      assert.notProperty(completed, "next");
      const waited = yield* service.waitForThread(scope, { threadId: childThreadId });
      assert.equal(waited.status, "completed");
      assert.notProperty(waited, "next");
    }).pipe(
      Effect.provide(
        layerOrchestratorService.pipe(
          Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(layerDependencies),
        ),
      ),
    );
  }),
);
