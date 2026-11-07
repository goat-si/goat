import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { layerTest, seedParentWithTerminalTask } from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("delegated completion races", (it) => {
  it.effect.each([
    { command: "acknowledge", before: "running", after: "failed", capture: false },
    { command: "acknowledge", before: "waiting", after: "completed", capture: true },
    { command: "accept", before: "waiting", after: "completed", capture: true },
    { command: "wake-policy", before: "running", after: "completed", capture: true },
  ] as const)(
    "keeps a $after run that settled between $command's read and commit",
    ({ command, before, after, capture }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const race = `${command}-settle-race-${after}`;
        const threadId = ThreadId.make(`thread:${race}`);
        const runId = RunId.make(`run:${race}`);
        const taskId = NodeId.make(`node:${race}-task`);
        const checkpointId = CheckpointId.make(`checkpoint:${race}`);
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make(`project:${race}`),
          runId,
          rootNodeId: NodeId.make(`node:${race}-root`),
          taskId,
          ...(command === "wake-policy"
            ? { deliveryState: "pending" }
            : { deliveryState: "claimed", deliveryTaskIds: [taskId] }),
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${race}-before`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...parent, status: before },
            },
            {
              id: EventId.make(`event:${race}-message`),
              type: "message.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId,
                nodeId: parent.rootNodeId,
                role: "user",
                text: "Background task finished",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
                delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
              },
            },
          ],
        });
        const { delegatedCompletion: _cohort, ...settledRun } = parent;
        const commit = sink.commitCommand;
        let settled = false;
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
              Effect.gen(function* () {
                if (
                  !settled &&
                  input.commandType ===
                    (command === "accept"
                      ? "notification.delivery.accept"
                      : command === "wake-policy"
                        ? "delegated_task.wake-policy"
                        : "delegated_task.completion-delivery.acknowledge")
                ) {
                  settled = true;
                  // The provider turn ends (or its checkpoint lands) after the command read the run.
                  yield* commit({
                    commandId: CommandId.make(`command:${race}`),
                    threadId,
                    commandType: capture ? "checkpoint.capture" : "provider.event",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make(`event:${race}-settled`),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...settledRun,
                          status: after,
                          completedAt: now,
                          checkpointId: capture ? checkpointId : null,
                        },
                      },
                    ],
                  });
                }
                return yield* commit(input);
              }),
            ),
          ),
          () =>
            orchestrator.dispatch(
              command === "accept"
                ? {
                    type: "notification.delivery.accept",
                    commandId: CommandId.make(`command:${race}:accept`),
                    threadId,
                    messageId,
                  }
                : command === "wake-policy"
                  ? {
                      type: "delegated_task.wake-policy",
                      commandId: CommandId.make(`command:${race}:wake-policy`),
                      parentThreadId: threadId,
                      taskId,
                      completionWake: "always",
                    }
                  : {
                      type: "delegated_task.completion-delivery.acknowledge",
                      commandId: CommandId.make(`command:${race}:task-status`),
                      parentThreadId: threadId,
                      taskId,
                      observedByRunId: runId,
                    },
            ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(settled);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          finished.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
          command === "accept"
            ? "delivered"
            : command === "wake-policy"
              ? "claimed"
              : "acknowledged",
        );
        const run = finished.runs.find((candidate) => candidate.id === runId)!;
        assert.deepEqual(
          { status: run.status, completedAt: run.completedAt, checkpointId: run.checkpointId },
          { status: after, completedAt: now, checkpointId: capture ? checkpointId : null },
        );
      }),
  );
});
