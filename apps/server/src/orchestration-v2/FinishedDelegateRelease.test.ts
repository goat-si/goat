import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  driver,
  modelSelection,
  layerTest,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect.each([
    { name: "releases", key: "", pendingBackgroundTasks: [], released: true },
    {
      name: "keeps while an unawaited background command runs",
      key: "-background",
      pendingBackgroundTasks: [{ taskId: "dev-server", kind: "command" as const }],
      released: false,
    },
  ])(
    "queues a child result without creating a provider history handoff and $name its process",
    ({ key, pendingBackgroundTasks, released }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:result-message${key}-parent`);
        const projectId = ProjectId.make(`project:result-message${key}`);
        const runId = RunId.make(`run:result-message${key}-parent`);
        const rootNodeId = NodeId.make(`node:result-message${key}-parent`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make(`node:result-message${key}-seed`),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: `result-message${key}-child`,
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
        const providerThreadId = ProviderThreadId.make(
          `provider-thread:result-message${key}-child`,
        );
        yield* eventSink.write({
          commandId: CommandId.make(`command:result-message${key}-child-provider`),
          events: [
            {
              id: EventId.make(`event:result-message${key}-child-session`),
              type: "provider-session.attached",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                id: ProviderSessionId.make(`provider-session:result-message${key}-child`),
                driver,
                providerInstanceId: modelSelection.instanceId,
                status: "ready",
                cwd: "/repo",
                model: modelSelection.model,
                capabilities: {
                  ...CodexProviderCapabilitiesV2,
                  sessions: {
                    ...CodexProviderCapabilitiesV2.sessions,
                    supportsMultipleProviderThreadsPerSession: false,
                  },
                },
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
            {
              id: EventId.make(`event:result-message${key}-child-provider`),
              type: "provider-thread.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                ...parent.providerThreads[0]!,
                id: providerThreadId,
                appThreadId: child.childThreadId,
                pendingBackgroundTasks,
              },
            },
            {
              id: EventId.make(`event:result-message${key}-child-run`),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: child.childRunId,
              occurredAt: now,
              payload: { ...childProjection.runs[0]!, providerThreadId },
            },
          ],
        });

        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((candidate) => candidate.id === child.taskId)!;
        assert.equal(task.status, "completed");
        assert.isNotNull(task.result);
        assert.isEmpty(recovered.contextHandoffs);
        assert.equal(recovered.contextTransfers.length, 1);
        // A one-process-per-thread child releases its process once its result is recorded,
        // unless background work it did not await would die with it.
        assert.equal(
          (yield* orchestrator.getThreadProjection(child.childThreadId)).providerSessions.length,
          released ? 0 : 1,
        );

        const delivery = recovered.runs.find((candidate) => candidate.id === runId)!
          .delegatedCompletion!.delivery!;
        const messageId = delivery.messageId;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:result-message${key}-delivery`),
          threadId,
          messageId,
          text: "Delegated task finished.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: [child.taskId],
          },
        });
        const queued = yield* orchestrator.getThreadProjection(threadId);
        assert.include(
          queued.messages.find((message) => message.id === messageId)?.text ?? "",
          task.result!,
        );
      }),
  );
});
