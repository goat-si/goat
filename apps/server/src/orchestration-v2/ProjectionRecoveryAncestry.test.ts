import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  makeThread,
  modelSelection,
  providerInstanceId,
  threadCreatedEvent,
} from "./FoundationPersistence.testkit.ts";

it.effect.each([
  ["SQL", ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s reads only requested runs' ancestry, including terminal turns", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("recovery-ancestry");
    yield* store.apply(
      threadCreatedEvent({ id: "event:thread", thread: makeThread(threadId, now), now }),
    );
    const providerThreadId = ProviderThreadId.make("provider-thread");
    for (const index of [1, 2]) {
      const runId = RunId.make(`run-${index}`);
      const attemptId = RunAttemptId.make(`attempt-${index}`);
      const turnId = ProviderTurnId.make(`turn-${index}`);
      const nodeId = NodeId.make(`node-${index}`);
      yield* store.apply({
        id: EventId.make(`event:run-${index}`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: index,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message-${index}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: index === 1 ? "cancelled" : "running",
          requestedAt: now,
          startedAt: now,
          completedAt: index === 1 ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:attempt-${index}`),
        type: "run-attempt.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId: turnId,
          reason: "initial",
          status: index === 1 ? "cancelled" : "running",
          startedAt: now,
          completedAt: index === 1 ? now : null,
        },
      });
      yield* store.apply({
        id: EventId.make(`event:turn-${index}`),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId,
        occurredAt: now,
        payload: {
          id: turnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: index,
          status: index === 1 ? "completed" : "running",
          startedAt: now,
          completedAt: index === 1 ? now : null,
        },
      });
    }
    const records = yield* store.getThreadRecords(threadId, ["runs", "attempts", "providerTurns"], {
      runIds: [RunId.make("run-1")],
      ancestryRunIds: [RunId.make("run-1")],
    });
    assert.deepEqual(
      records.runs.map((row) => row.id),
      [RunId.make("run-1")],
    );
    assert.deepEqual(
      records.attempts.map((row) => row.id),
      [RunAttemptId.make("attempt-1")],
    );
    assert.deepEqual(
      records.providerTurns.map((row) => [row.id, row.status]),
      [[ProviderTurnId.make("turn-1"), "completed"]],
    );
    const empty = yield* store.getThreadRecords(threadId, ["attempts", "providerTurns"], {
      ancestryRunIds: [],
    });
    assert.deepEqual([empty.attempts, empty.providerTurns], [[], []]);
  }).pipe(Effect.provide(layer)),
);
