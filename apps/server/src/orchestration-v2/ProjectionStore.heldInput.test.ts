import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProjectionStore from "./ProjectionStore.ts";
import {
  driver,
  layerTest,
  modelSelection,
  providerInstanceId,
} from "./ProjectionStore.testkit.ts";
import { THREAD_HISTORY_PAGE_POLICY } from "./threadHistoryPaging.ts";

it.layer(layerTest)("ProjectionStoreV2 held queued input", (it) => {
  it.effect("keeps undelivered queued input out of forks taken after a later run", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-held-queue");

      for (const heldStatus of ["queued", "cancelled"] as const) {
        const prefix = `projection-fork-held-queue:${heldStatus}`;
        const sourceThreadId = ThreadId.make(`thread:${prefix}:source`);
        const targetThreadId = ThreadId.make(`thread:${prefix}:target`);
        const heldRunId = RunId.make(`run:${prefix}:held`);
        const heldAttemptId = RunAttemptId.make(`attempt:${prefix}:held`);
        const answeredRunId = RunId.make(`run:${prefix}:answered`);

        for (const [threadId, forkedFrom] of [
          [sourceThreadId, null],
          [targetThreadId, { type: "run", threadId: sourceThreadId, runId: answeredRunId }],
        ] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${threadId}:created`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: threadId,
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: forkedFrom === null ? null : sourceThreadId,
                relationshipToParent: forkedFrom === null ? null : "fork",
                rootThreadId: sourceThreadId,
              },
              forkedFrom,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
        }

        const applyRun = (
          runId: RunId,
          ordinal: number,
          status: typeof heldStatus | "completed" | "rolled_back",
        ) =>
          projectionStore.apply({
            id: EventId.make(`event:${runId}:${status}`),
            type: "run.updated",
            threadId: sourceThreadId,
            runId,
            nodeId: NodeId.make(`node:${runId}`),
            driver,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: sourceThreadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`message:${runId}`),
              rootNodeId: NodeId.make(`node:${runId}`),
              activeAttemptId: runId === heldRunId ? heldAttemptId : null,
              status,
              requestedAt: now,
              startedAt: runId === heldRunId ? null : now,
              completedAt: status === "queued" ? null : now,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
        const applyUserItem = (input: {
          readonly threadId: ThreadId;
          readonly runId: RunId | null;
          readonly ordinal: number;
          readonly text: string;
          readonly inputIntent: "turn_start" | "queued_turn";
        }) =>
          projectionStore.apply({
            id: EventId.make(`event:${input.threadId}:item:${input.ordinal}`),
            type: "turn-item.updated",
            threadId: input.threadId,
            ...(input.runId === null ? {} : { runId: input.runId }),
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: TurnItemId.make(`turn-item:${input.threadId}:${input.ordinal}`),
              threadId: input.threadId,
              runId: input.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId: MessageId.make(`message:${input.threadId}:${input.ordinal}`),
              inputIntent: input.inputIntent,
              text: input.text,
              attachments: [],
            },
          });

        yield* applyRun(heldRunId, 1, heldStatus);
        yield* projectionStore.apply({
          id: EventId.make(`event:${heldAttemptId}:created`),
          type: "run-attempt.created",
          threadId: sourceThreadId,
          runId: heldRunId,
          nodeId: NodeId.make(`node:${heldRunId}`),
          driver,
          occurredAt: now,
          payload: {
            id: heldAttemptId,
            runId: heldRunId,
            attemptOrdinal: 1,
            rootNodeId: NodeId.make(`node:${heldRunId}`),
            providerInstanceId,
            providerThreadId: ProviderThreadId.make(`provider-thread:${prefix}`),
            providerTurnId: null,
            reason: "initial",
            status: heldStatus === "queued" ? "pending" : "cancelled",
            startedAt: null,
            completedAt: heldStatus === "queued" ? null : now,
          },
        });
        yield* applyRun(answeredRunId, 2, "completed");
        yield* applyUserItem({
          threadId: sourceThreadId,
          runId: heldRunId,
          ordinal: 100,
          text: "held",
          inputIntent: "queued_turn",
        });
        yield* applyUserItem({
          threadId: sourceThreadId,
          runId: answeredRunId,
          ordinal: 200,
          text: "answered",
          inputIntent: "turn_start",
        });
        yield* applyUserItem({
          threadId: sourceThreadId,
          runId: answeredRunId,
          ordinal: 201,
          text: "delivered steer",
          inputIntent: "queued_turn",
        });
        // Enough local turns for a turn-limited window to count inherited rows in SQL.
        for (let index = 0; index < THREAD_HISTORY_PAGE_POLICY.maxUserTurns; index += 1) {
          yield* applyUserItem({
            threadId: targetThreadId,
            runId: null,
            ordinal: index,
            text: `local ${index}`,
            inputIntent: "turn_start",
          });
        }

        const assertForkHidesHeldInput = Effect.fn("assertForkHidesHeldInput")(function* () {
          const target = yield* projectionStore.getThreadProjection(targetThreadId);
          assert.deepEqual(
            target.visibleTurnItems
              .slice(0, 3)
              .map((row) => (row.item.type === "user_message" ? row.item.text : row.item.type)),
            ["answered", "delivered steer", "fork"],
          );
          const page = yield* projectionStore.getTimelinePage(targetThreadId, {
            view: "activity",
            limit: target.visibleTurnItems.length + 1,
          });
          assert.deepEqual(page.items, target.visibleTurnItems);
          const bounded = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
            rowLimit: target.visibleTurnItems.length + 1,
          });
          assert.deepEqual(bounded.projection.visibleTurnItems, target.visibleTurnItems);
          const shellSnapshot = yield* projectionStore.getShellSnapshot();
          for (const projection of [
            yield* projectionStore.getThreadProjection(sourceThreadId),
            target,
          ]) {
            for (const shell of [
              yield* projectionStore.getThreadShell(projection.thread.id),
              shellSnapshot.threads.find((thread) => thread.id === projection.thread.id),
            ]) {
              assert.equal(shell?.visibleItemCount, projection.visibleTurnItems.length);
            }
          }
          const filledLocalPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
            rowLimit: target.visibleTurnItems.length,
            userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
          });
          assert.deepEqual(
            filledLocalPage.projection.visibleTurnItems.filter((row) => row.visibility === "local"),
            target.visibleTurnItems.filter((row) => row.visibility === "local"),
          );
        });

        yield* assertForkHidesHeldInput();
        // Forks keep rolled-back source history, but still not undelivered input.
        yield* applyRun(answeredRunId, 2, "rolled_back");
        yield* assertForkHidesHeldInput();
        // Rollback also takes cancelled runs, and overwrites the status that hid their input.
        if (heldStatus === "cancelled") {
          yield* applyRun(heldRunId, 1, "rolled_back");
          yield* assertForkHidesHeldInput();
        }
      }
    }),
  );
});
