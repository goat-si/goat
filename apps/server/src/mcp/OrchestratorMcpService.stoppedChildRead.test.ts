import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import {
  childRuns,
  continued,
  layerTest,
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
      // The read saw the cancelled notice, not the task's interrupted run, so the parent is
      // still woken with the task's result.
      const task = (yield* fixture.store.getThreadRecords(parentId, ["subagents"])).subagents.find(
        (candidate) => candidate.id === created.taskId,
      );
      assert.equal(task?.completionDelivery?.state, "pending");
    }).pipe(Effect.provide(layerTest)),
);
