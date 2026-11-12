import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";

it.effect("retries terminal acknowledgement with a fresh command id", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
    const childThreadId = ThreadId.make("thread:mcp-ack-child");
    const childRunId = RunId.make("run:mcp-ack-child");
    const childAttemptId = RunAttemptId.make("attempt:mcp-ack-child");
    const taskId = NodeId.make("node:mcp-ack-task");
    const resultTransferId = ContextTransferId.make("transfer:mcp-ack-result");
    const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
    const acknowledgementAttempts = yield* Ref.make(0);
    const parentProjection = {
      thread: { id: parentThreadId },
      runs: [],
      contextTransfers: [
        {
          id: resultTransferId,
          type: "subagent_result",
          sourceThreadId: childThreadId,
          targetThreadId: parentThreadId,
          sourcePoint: { runId: childRunId },
        },
      ],
      subagents: [
        {
          id: taskId,
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
          driver: "codex",
          model: "gpt-5.6-terra",
          result: "terminal result",
          completionDelivery: { state: "pending" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const childProjection = {
      thread: { id: childThreadId, title: "Child" },
      runs: [
        {
          id: childRunId,
          activeAttemptId: childAttemptId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" },
          ordinal: 1,
          status: "completed",
          startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
          completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
        },
        {
          id: RunId.make("run:mcp-ack-continuation"),
          ordinal: 2,
          status: "failed",
          startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
          completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
        },
      ],
      contextTransfers: [],
      messages: [
        {
          id: MessageId.make("message:mcp-ack-result"),
          runId: childRunId,
          role: "assistant",
          text: "terminal result",
          createdAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          updatedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
        },
      ],
      turnItems: [],
      subagents: [],
      providerThreads: [],
      providerTurns: [{ runAttemptId: childAttemptId, ordinal: 1, model: "claude-opus-4-5" }],
      runtimeRequests: [],
    } as unknown as OrchestrationV2ThreadProjection;
    let hasNestedWork = true;
    let settleAfterTaskRead = false;
    const layerDependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId) =>
          Effect.sync(() => {
            if (threadId !== parentThreadId) {
              return hasNestedWork
                ? {
                    ...childProjection,
                    subagents: [{ ...parentProjection.subagents[0]!, status: "running" as const }],
                  }
                : childProjection;
            }
            const snapshot = hasNestedWork
              ? {
                  ...parentProjection,
                  contextTransfers: [],
                  subagents: parentProjection.subagents.map((task) => ({
                    ...task,
                    result: null,
                    status: "running" as const,
                  })),
                }
              : parentProjection;
            if (settleAfterTaskRead) {
              settleAfterTaskRead = false;
              hasNestedWork = false;
            }
            return snapshot;
          }),
        delegatedTaskResultPending: () => Effect.succeed(false),
        dispatch: (command) =>
          Ref.update(acknowledgementCommandIds, (commandIds) => [
            ...commandIds,
            String(command.commandId),
          ]).pipe(
            Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                : Effect.succeed({} as never),
            ),
          ),
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
      environmentId: EnvironmentId.make("environment:mcp-ack"),
      requestNamespace: "provider-session:mcp-ack",
      thread: {
        threadId: parentThreadId,
        providerSessionId: "provider-session:mcp-ack",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };

    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const pending = yield* service.taskStatus(scope, taskId);
      assert.equal(pending.status, "running");
      assert.equal(pending.workState, "waiting_for_children");
      assert.isNull(pending.summary);
      assert.isNull(pending.resultContextTransferId);
      assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
      hasNestedWork = false;
      const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
      assert.equal(error.code, "orchestration_error");

      // Completion lands after task selection, before the remaining parent/child reads.
      hasNestedWork = true;
      settleAfterTaskRead = true;
      const result = yield* service.taskStatus(scope, taskId);
      assert.equal(result.status, "completed");
      assert.equal(
        result.summary,
        "Requested model gpt-5.6-terra; the provider reported running claude-opus-4-5.\n\nterminal result",
      );
      assert.equal(result.executedModel, "claude-opus-4-5");
      assert.equal(result.latestTerminalRunId, childRunId);
      assert.equal(result.latestTerminalStatus, "completed");
      assert.equal(result.resultContextTransferId, resultTransferId);
      const commandIds = yield* Ref.get(acknowledgementCommandIds);
      assert.equal(commandIds.length, 2);
      assert.notEqual(commandIds[0], commandIds[1]);
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
