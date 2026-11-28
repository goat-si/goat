import { assert, it } from "@effect/vitest";
import { CommandId, EventId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  instanceId,
  layerTest,
  createWatchingThread,
  send,
  delegate,
  threadState,
} from "./ThreadStop.testkit.ts";

it.effect(
  "stopDelegatedTasks skips idle completed children while still stopping active follow-ups and grandchildren",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const parentThreadId = ThreadId.make("thread:stop-skip-idle-parent");
      yield* createWatchingThread(parentThreadId, 30);
      yield* send(parentThreadId, "parent", "start_immediately");
      const idleChildId = yield* delegate(parentThreadId, "idle completed child");
      const intermediateChildId = yield* delegate(
        parentThreadId,
        "completed child with active grandchild",
      );
      const activeGrandchildId = yield* delegate(intermediateChildId, "running grandchild");
      const followupChildId = yield* delegate(parentThreadId, "completed child with follow-up");

      const now = yield* DateTime.now;
      const completeThreadRun = (threadId: ThreadId, eventPrefix: string) =>
        Effect.gen(function* () {
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          yield* projections.apply({
            id: EventId.make(`event:${eventPrefix}:run-completed`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", startedAt: now, completedAt: now },
          });
        });

      yield* completeThreadRun(idleChildId, "stop-skip-idle:leaf");
      yield* completeThreadRun(intermediateChildId, "stop-skip-idle:intermediate");
      yield* completeThreadRun(followupChildId, "stop-skip-idle:followup");

      const parentSubagents = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents;
      for (const task of parentSubagents) {
        yield* projections.apply({
          id: EventId.make(`event:stop-skip-idle:task:${task.id}`),
          type: "subagent.updated",
          threadId: parentThreadId,
          runId: task.runId!,
          nodeId: task.id,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "done",
            completedAt: now,
            completionDelivery: { state: "acknowledged", observedByRunId: null },
          },
        });
      }

      // Mark the intermediate child's task for its grandchild completed too, while leaving the
      // grandchild's own run active, so recursion must still inspect descendants.
      const intermediateBefore = yield* orchestrator.getThreadProjection(intermediateChildId);
      const intermediateTask = intermediateBefore.subagents[0]!;
      const intermediateTaskItem = intermediateBefore.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === intermediateTask.id,
      )!;
      yield* projections.apply({
        id: EventId.make("event:stop-skip-idle:grandchild-task"),
        type: "subagent.updated",
        threadId: intermediateChildId,
        runId: intermediateTask.runId!,
        nodeId: intermediateTask.id,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          ...intermediateTask,
          status: "completed",
          result: "done",
          completedAt: now,
          completionDelivery: { state: "acknowledged", observedByRunId: null },
        },
      });
      yield* projections.apply({
        id: EventId.make("event:stop-skip-idle:grandchild-task-item"),
        type: "turn-item.updated",
        threadId: intermediateChildId,
        runId: intermediateTask.runId!,
        nodeId: intermediateTask.id,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: { ...intermediateTaskItem, status: "completed", completedAt: now, updatedAt: now },
      });

      // Start a new follow-up turn directly on the third child after its original task completed.
      yield* send(followupChildId, "follow-up work", "start_immediately");

      yield* threads.stopDelegatedTasks({
        threadId: parentThreadId,
        commandId: CommandId.make("stop-skip-idle"),
      });

      const idleProjection = yield* orchestrator.getThreadProjection(idleChildId);
      assert.isEmpty(
        idleProjection.turnItems.filter((item) => item.type === "run_interrupt_request"),
      );
      assert.isFalse((yield* projections.getThreadShell(idleChildId))?.latestRunStopRequested);

      const intermediateProjection = yield* orchestrator.getThreadProjection(intermediateChildId);
      assert.isEmpty(
        intermediateProjection.turnItems.filter((item) => item.type === "run_interrupt_request"),
      );
      assert.deepEqual((yield* threadState(activeGrandchildId)).runs, ["interrupted"]);
      assert.deepEqual((yield* threadState(followupChildId)).runs, ["completed", "interrupted"]);
    }).pipe(Effect.provide(layerTest)),
);
