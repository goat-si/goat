import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  adapter,
  instanceId,
  layerTest,
  createWatchingThread,
  send,
  threadState,
} from "./ThreadStop.testkit.ts";
const modelSelection = { instanceId, model: "gpt-5.1-codex" };

it.effect(
  "an agent's auto send queues behind a run that is still stopping instead of steering it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const threadId = ThreadId.make("thread:stop-mcp-send");
      yield* createWatchingThread(threadId, 6);
      yield* send(threadId, "active", "start_immediately");
      const initial = yield* orchestrator.getThreadProjection(threadId);
      const run = initial.runs[0]!;
      const providerSessionId = ProviderSessionId.make("session:stop-mcp-send");
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:session"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...initial.providerThreads[0]!, providerSessionId },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:running"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "running", startedAt: now },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-mcp-send:turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("provider-turn:stop-mcp-send"),
          providerThreadId: run.providerThreadId!,
          nodeId: run.rootNodeId!,
          runAttemptId: run.activeAttemptId!,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      yield* send(threadId, "queued before the stop", "queue_after_active");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-mcp-send"),
        threadId,
      });
      assert.deepEqual((yield* threadState(threadId)).runs, ["running", "queued:held"]);

      const result = yield* threads.sendToThread({
        projectId: ProjectId.make("project:thread-stop"),
        commandId: CommandId.make("command:stop-mcp-send"),
        threadId,
        messageId: MessageId.make("message:stop-mcp-send"),
        text: "Follow up after Stop",
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.equal(result.delivery, "queued");
      assert.deepEqual((yield* threadState(threadId)).runs, [
        "running",
        "queued:held",
        "queued:held",
      ]);
    }).pipe(Effect.provide(layerTest)),
);
