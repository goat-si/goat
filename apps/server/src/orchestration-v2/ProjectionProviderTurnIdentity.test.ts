import { assert, it } from "@effect/vitest";
import { EventId, NodeId, ProviderThreadId, ProviderTurnId, RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import { addRolledBackRecoveryCandidate, layerTest } from "./ProjectionStore.testkit.ts";

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s provider-turn reads target only requested identities", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("bounded-provider-evidence");
    const now = yield* DateTime.now;
    const attemptId = RunAttemptId.make("bounded-evidence-attempt");
    for (const ordinal of [1, 2]) {
      yield* store.apply({
        id: EventId.make(`bounded-evidence:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`bounded-turn:${ordinal}`),
          providerThreadId: ProviderThreadId.make("bounded-provider-thread"),
          nodeId: NodeId.make("bounded-node"),
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    const records = yield* store.getThreadRecords(threadId, ["providerTurns"], {
      providerTurnIds: [ProviderTurnId.make("bounded-turn:2")],
    } as never);
    assert.deepEqual(
      records.providerTurns.map((turn) => turn.id),
      ["bounded-turn:2"],
    );
  }).pipe(Effect.provide(layer)),
);
