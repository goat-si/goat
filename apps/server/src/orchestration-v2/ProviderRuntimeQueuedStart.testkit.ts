import { assert } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProviderThreadId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectOutbox from "./EffectOutbox.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import { makeThread, threadCreatedEvent } from "./FoundationPersistence.testkit.ts";

export const seedQueuedStarts = Effect.fn("test.seedQueuedStarts")(function* (
  store: ProjectionStore.ProjectionStoreV2["Service"],
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  now: DateTime.Utc,
) {
  const plain = yield* store.getThreadProjection(ThreadId.make("plain"));
  const sourceRun = plain.runs[0];
  const sourceThread = plain.providerThreads[0];
  if (!sourceRun || !sourceThread) return yield* Effect.die("missing survivor fixture");
  const queuedThread = ThreadId.make("queued-shared");
  const queuedProviderThread = ProviderThreadId.make("provider-thread-queued");
  yield* store.apply(
    threadCreatedEvent({
      id: "event:queued:thread",
      thread: {
        ...makeThread(queuedThread, now),
        providerInstanceId: sourceRun.providerInstanceId,
        modelSelection: sourceRun.modelSelection,
      },
      now,
    }),
  );
  yield* store.apply({
    id: EventId.make("event:queued:provider-thread"),
    type: "provider-thread.updated",
    threadId: queuedThread,
    driver: sourceThread.driver,
    providerInstanceId: sourceRun.providerInstanceId,
    occurredAt: now,
    payload: {
      ...sourceThread,
      id: queuedProviderThread,
      appThreadId: queuedThread,
      nativeThreadRef: null,
    },
  });
  for (const threadId of [ThreadId.make("plain"), queuedThread]) {
    const runId = RunId.make(`queued-${threadId}`);
    yield* store.apply({
      id: EventId.make(`event:${runId}`),
      type: "run.created",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        ...sourceRun,
        id: runId,
        threadId,
        ordinal: 5,
        providerThreadId: threadId === queuedThread ? queuedProviderThread : sourceThread.id,
        userMessageId: MessageId.make(`message-${runId}`),
        activeAttemptId: null,
        rootNodeId: null,
        status: "starting",
        startedAt: null,
        completedAt: null,
      },
    });
    yield* outbox.enqueue([
      {
        id: `effect:${runId}`,
        commandId: CommandId.make(`command:${runId}`),
        threadId,
        request: { type: "provider-turn.start", runId },
      },
    ]);
  }
});

export const assertQueuedStarts = Effect.fn("test.assertQueuedStarts")(function* (
  store: ProjectionStore.ProjectionStoreV2["Service"],
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  order: ReadonlyArray<string>,
) {
  for (const threadId of [ThreadId.make("plain"), ThreadId.make("queued-shared")]) {
    const runId = RunId.make(`queued-${threadId}`);
    const projection = yield* store.getThreadProjection(threadId);
    assert.equal(projection.runs.find((run) => run.id === runId)?.status, "starting");
    const start = yield* outbox.get(`effect:${runId}`);
    assert.isTrue(
      Option.isSome(start) && start.value.status === "pending" && start.value.attemptCount === 0,
    );
    assert.notInclude(order, `block:${threadId}`);
  }
});
