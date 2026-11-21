import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import { addRolledBackRecoveryCandidate, layerTest } from "./ProjectionStore.testkit.ts";

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s attempt reads target only requested identities", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("attempt-identities");
    const now = yield* DateTime.now;
    for (const ordinal of [1, 2])
      yield* store.apply({
        id: EventId.make(`attempt-identity:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        runId: RunId.make("run:identity"),
        nodeId: NodeId.make("node:identity"),
        occurredAt: now,
        payload: {
          id: RunAttemptId.make(`attempt:identity:${ordinal}`),
          runId: RunId.make("run:identity"),
          attemptOrdinal: ordinal,
          rootNodeId: NodeId.make("node:identity"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerThreadId: ProviderThreadId.make("provider:identity"),
          providerTurnId: null,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    const records = yield* store.getThreadRecords(threadId, ["attempts"], {
      attemptIds: [RunAttemptId.make("attempt:identity:2")],
    } as never);
    assert.deepEqual(
      records.attempts.map((attempt) => attempt.id),
      ["attempt:identity:2"],
    );
  }).pipe(Effect.provide(layer)),
);
