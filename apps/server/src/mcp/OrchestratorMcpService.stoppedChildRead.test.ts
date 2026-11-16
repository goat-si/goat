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

it.effect(
  "a summary read of a stopped task child whose queued notice Stop cancelled leaves its completion delivery owed",
  () =>
    Effect.gen(function* () {
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
      const beforeStop = yield* eventSink.latestSequence();
      yield* fixture.orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stopped-child-stop"),
        threadId: fixture.childThreadId,
      });
      // The orchestrator's run-update reactor finalizes the stopped task in the background and
      // owes its result to the parent: the delivery is claimed before any read.
      yield* eventSink.stream({ afterSequence: beforeStop, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === created.taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const [, taskRun, notice] = yield* childRuns(fixture.childThreadId);
      assert.equal(taskRun?.status, "interrupted");
      assert.equal(notice?.status, "cancelled");
      assert.deepEqual(notice?.completedAt, taskRun?.completedAt);
      // The shell presents the run that ran; goat_thread_read names the newest run by ordinal.
      const shell = yield* fixture.store.getThreadShell(fixture.childThreadId);
      assert.equal(shell?.latestRunId, taskRun?.id);
      const read = yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          const input = { threadId: fixture.childThreadId, view: "summary" as const };
          const result = yield* service.readThread(scope, input);
          // What the host service does after a summary read (HostThreadsMcpService.readThread).
          yield* service.acknowledgeChildRead(scope, input, result.thread);
          return result.thread;
        }),
      );
      assert.equal(read.latestRunId, notice?.id);
      // The read saw the cancelled notice, not the task's interrupted run, so it acknowledges
      // nothing and the parent is still woken with the task's result.
      const task = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.find(
        (candidate) => candidate.id === created.taskId,
      );
      assert.equal(task?.completionDelivery?.state, "claimed");
      // The claimed delivery is a real wake: it is offered to the parent's still-active run.
      const parent = yield* fixture.store.getThreadRecords(parentId, ["runs", "messages"]);
      const delivery = parent.runs
        .flatMap((run) => run.delegatedCompletion?.delivery ?? [])
        .find((candidate) => candidate.taskIds.includes(created.taskId));
      assert.isDefined(delivery);
      const wake = yield* (yield* ProviderContinuationRequests.ProviderContinuationRequests).take;
      assert.equal(wake.threadId, parentId);
      assert.deepEqual(wake.delegatedCompletion, {
        parentRunId: parent.runs.find((run) => run.delegatedCompletion?.delivery === delivery)?.id,
        generation: delivery?.generation,
        messageId: delivery?.messageId,
      });
    }).pipe(Effect.provide(layerTestWithContinuations)),
);
