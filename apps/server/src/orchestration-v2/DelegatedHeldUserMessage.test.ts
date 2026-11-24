import { assert, it } from "@effect/vitest";
import { EventId, MessageId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  layerTest,
  runEvent,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.effect("keeps a stopped delegated task open until its held user message is discarded", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const sink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:held-user-parent");
    const projectId = ProjectId.make("project:held-user");
    const runId = RunId.make("run:held-user-parent");
    const rootNodeId = NodeId.make("node:held-user-parent");
    yield* seedParentWithTerminalTask({
      threadId,
      projectId,
      runId,
      rootNodeId,
      taskId: NodeId.make("node:held-user-seed"),
      deliveryState: "acknowledged",
      now,
    });
    const child = yield* seedRestartCancelledChild({
      parentThreadId: threadId,
      projectId,
      parentRunId: runId,
      rootNodeId,
      name: "held-user-child",
      completionWake: "always",
      continuationPending: false,
      now,
    });
    const held = runEvent({
      threadId: child.childThreadId,
      runId: RunId.make("run:held-user-message"),
      ordinal: 2,
      status: "queued",
      now,
    });
    yield* sink.write({
      events: [
        {
          ...held,
          payload: {
            ...held.payload,
            userMessageId: MessageId.make("message:held-user"),
            startedAt: null,
            completedAt: null,
            queueHeld: true,
          },
        },
        {
          id: EventId.make("event:held-user-message"),
          type: "message.updated",
          threadId: child.childThreadId,
          runId: held.payload.id,
          occurredAt: now,
          payload: {
            id: MessageId.make("message:held-user"),
            threadId: child.childThreadId,
            runId: held.payload.id,
            nodeId: null,
            role: "user",
            createdBy: "user",
            creationSource: "web",
            text: "Continue",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.recoverDelegatedTask(child.childThreadId, {
      sourceRunId: child.childRunId,
    });
    let parent = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(parent.subagents.find((task) => task.id === child.taskId)?.result);
    assert.isFalse(
      parent.messages.some((message) =>
        message.delegatedCompletion?.taskIds.includes(child.taskId),
      ),
    );
    yield* sink.write({
      events: [
        {
          ...held,
          id: EventId.make("event:held-user-discarded"),
          payload: { ...held.payload, status: "cancelled", completedAt: now },
        },
      ],
    });
    yield* orchestrator.recoverDelegatedTask(child.childThreadId, {
      sourceRunId: child.childRunId,
    });
    parent = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(parent.subagents.find((task) => task.id === child.taskId)?.status, "cancelled");
  }).pipe(Effect.provide(layerTest)),
);
