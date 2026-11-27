import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  ScheduledTaskId,
  ThreadId,
  type CheckpointId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { OrchestratorV2Shape } from "../Orchestrator.ts";
import type { EventSinkV2Shape } from "../EventSink.ts";

export const assertQueuedFreshFork = Effect.fn("assertQueuedFreshFork")(function* (
  orchestrator: OrchestratorV2Shape,
  eventSink: EventSinkV2Shape,
  parentId: ThreadId,
  checkpointId: CheckpointId,
  scheduled: boolean,
) {
  const key = scheduled ? "queued-scheduled-side-chat" : "queued-fresh-side-chat";
  const parent = yield* orchestrator.getThreadProjection(parentId);
  const source = parent.runs[0];
  assert.isDefined(source);
  if (source.providerThreadId === null) {
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("queued-fresh-source-provider");
    const driver = ProviderDriverKind.make("codex");
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("queued-fresh-source-provider"),
          type: "provider-thread.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: source.providerInstanceId,
            providerSessionId: null,
            appThreadId: parentId,
            ownerNodeId: null,
            nativeThreadRef: { driver, nativeId: "queued-fresh-source", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("queued-fresh-source-run"),
          type: "run.updated",
          threadId: parentId,
          runId: source.id,
          occurredAt: now,
          payload: { ...source, providerThreadId },
        },
      ],
    });
  }
  const threadId = ThreadId.make(`${key}-child`);
  yield* orchestrator.dispatch({
    type: "thread.fork",
    commandId: CommandId.make(`${key}-fork`),
    sourceThreadId: parentId,
    targetThreadId: threadId,
    sourcePoint: { type: "checkpoint", checkpointId },
    sideChat: true,
    createdBy: "user",
    creationSource: "web",
  });
  const send = (name: string, fresh = false) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${key}-${name}`),
      threadId,
      messageId: MessageId.make(`${key}-${name}`),
      text: name,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
      ...(fresh ? { freshContext: true } : {}),
      ...(fresh && scheduled ? { scheduledTaskId: ScheduledTaskId.make(`${key}-task`) } : {}),
    });
  const settle = Effect.fn("settleQueuedFreshFork")(function* (
    name: string,
    status: "failed" | "completed",
  ) {
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (r) => r.userMessageId === MessageId.make(`${key}-${name}`),
    );
    assert.isDefined(run);
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${key}-${name}-${status}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
  });
  yield* send("first");
  yield* send("fresh", true);
  yield* settle("first", "failed");
  yield* orchestrator.dispatch({
    type: "queue.resume",
    commandId: CommandId.make(`${key}-resume`),
    threadId,
  });
  const fresh = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
    (run) => run.userMessageId === MessageId.make(`${key}-fresh`),
  );
  assert.equal(fresh?.status, "starting");
  yield* settle("fresh", "completed");
  yield* send("next");
  const sideChat = yield* orchestrator.getThreadProjection(threadId);
  assert.deepEqual(
    sideChat.contextTransfers
      .filter((transfer) => transfer.type === "fork")
      .map((transfer) => transfer.status),
    [scheduled ? "pending" : "superseded"],
  );
  if (!scheduled) {
    const next = sideChat.runs.find((run) => run.userMessageId === MessageId.make(`${key}-next`));
    assert.deepEqual(
      sideChat.contextHandoffs.filter((handoff) => handoff.targetRunId === next?.id),
      [],
    );
  }
});
