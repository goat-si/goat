import { assert, it } from "@effect/vitest";
import { EventId, ProviderThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  addRolledBackRecoveryCandidate,
  driver,
  layerTest,
  providerInstanceId,
} from "./ProjectionStore.testkit.ts";

it.effect("a stored provider thread keeps the turn item that started each background task", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("pending-task-native-item");
    const now = yield* DateTime.now;
    for (const [suffix, task] of [
      ["with", { taskId: "task-new", kind: "command", nativeItemId: "toolu_new" }],
      ["without", { taskId: "task-old", kind: "command" }],
    ] as const) {
      yield* store.apply({
        id: EventId.make("event:pending-task-native-item:" + suffix),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make("provider-thread:pending-task-native-item:" + suffix),
          appThreadId: threadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "idle",
          firstRunOrdinal: 1,
          pendingBackgroundTasks: [task],
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const stored = (yield* store.getThreadProjection(threadId)).providerThreads.flatMap(
      (providerThread) => providerThread.pendingBackgroundTasks ?? [],
    );
    assert.deepEqual(
      stored.toSorted((left, right) => left.taskId.localeCompare(right.taskId)),
      [
        { taskId: "task-new", kind: "command", nativeItemId: "toolu_new" },
        { taskId: "task-old", kind: "command" },
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);
