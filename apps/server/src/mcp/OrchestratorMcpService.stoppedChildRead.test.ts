import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import {
  childRuns,
  continued,
  layerTestWithContinuations,
  makeFixture,
  parentId,
  scope,
  withService,
} from "./OrchestratorMcpService.reviewContinuation.testkit.ts";

const stopWithQueuedNotice = Effect.gen(function* () {
  const fixture = yield* makeFixture;
  const created = yield* continued(fixture);
  const eventSink = yield* EventSink.EventSinkV2;
  yield* fixture.orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("stopped-child-notice"),
    threadId: fixture.childThreadId,
    messageId: MessageId.make("stopped-child-notice"),
    text: "Monitor line",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "provider",
    notification: { source: { kind: "monitor" }, outcome: "updated", summary: "Monitor line" },
  });
  yield* fixture.orchestrator.dispatch({
    type: "thread.stop",
    commandId: CommandId.make("stopped-child-stop"),
    threadId: fixture.childThreadId,
  });
  // This reviewer has two rounds on the same thread. Acknowledge a stable result revision.
  yield* eventSink.stream({ afterSequence: 0, eventType: "context-transfer.created" }).pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "context-transfer.created" &&
        event.payload.type === "subagent_result" &&
        event.payload.sourceThreadId === fixture.childThreadId &&
        event.payload.targetThreadId === parentId,
    ),
    Stream.take(2),
    Stream.runDrain,
  );
  const [, taskRun, notice] = yield* childRuns(fixture.childThreadId);
  assert.equal(taskRun?.status, "interrupted");
  assert.equal(notice?.status, "cancelled");
  assert.deepEqual(notice?.completedAt, taskRun?.completedAt);
  assert.isDefined(taskRun);
  return { fixture, taskId: created.taskId, taskRun, notice };
});

it.effect(
  "reading a stopped child acknowledges the interrupted task despite a later cancelled notice",
  () =>
    Effect.gen(function* () {
      const { fixture, taskId, taskRun, notice } = yield* stopWithQueuedNotice;
      yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          const input = { threadId: fixture.childThreadId, view: "summary" as const };
          const status = yield* service.threadStatus(scope, { threadId: fixture.childThreadId });
          assert.equal(status.run?.runId, taskRun.id);
          const read = yield* service.readThread(scope, input);
          assert.equal(read.thread.latestRunId, status.run?.runId);
          assert.equal(read.thread.status, "interrupted");
          assert.deepEqual(
            read.recentRuns.map((run) => run.runId),
            [taskRun.id],
          );
          yield* service.acknowledgeChildRead(scope, input, read.thread);
          const { subagents } = yield* fixture.store.getThreadRecords(parentId, ["subagents"]);
          assert.equal(
            subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
            "acknowledged",
          );
          const tail = { threadId: fixture.childThreadId, tail: 1, runLimit: 2 };
          const again = yield* service.readThread(scope, tail);
          assert.deepEqual(
            again.recentRuns.map((run) => run.runId),
            [notice?.id, taskRun.id],
          );
          yield* service.acknowledgeChildRead(scope, tail, again.thread);
        }),
      );
      const parent = yield* fixture.store.getThreadRecords(parentId, ["runs", "subagents"]);
      const task = parent.subagents.find((candidate) => candidate.id === taskId);
      assert.equal(task?.completionDelivery?.state, "acknowledged");
      assert.isFalse(
        parent.runs.some((run) => run.delegatedCompletion?.delivery?.taskIds.includes(taskId)),
      );
    }).pipe(Effect.provide(layerTestWithContinuations)),
);

it.effect("an unread stopped child still wakes the parent with its result", () =>
  Effect.gen(function* () {
    const { fixture, taskId } = yield* stopWithQueuedNotice;
    const wake = yield* (yield* ProviderContinuationRequests.ProviderContinuationRequests).take;
    const parent = yield* fixture.store.getThreadRecords(parentId, ["runs"]);
    const run = parent.runs.find((candidate) =>
      candidate.delegatedCompletion?.delivery?.taskIds.includes(taskId),
    );
    const delivery = run?.delegatedCompletion?.delivery;
    assert.isDefined(delivery);
    assert.equal(wake.threadId, parentId);
    assert.deepEqual(wake.delegatedCompletion, {
      parentRunId: run?.id,
      generation: delivery?.generation,
      messageId: delivery?.messageId,
    });
  }).pipe(Effect.provide(layerTestWithContinuations)),
);
