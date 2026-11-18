import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Service from "../../../memory/MemoryService.ts";
import * as Store from "../../../memory/MemoryStore.ts";
import { makeMemoryMutationHandlers } from "../../../memory/MemoryMutationHandlers.ts";
import { makeMemorySaveSuggestions } from "../../../memory/MemorySaveSuggestions.ts";
import { memoryOperationDigest } from "../../../memory/MemoryDecider.ts";
import * as Fixture from "./handlers.testkit.ts";

const origin = {
  environmentId: Fixture.scope().environmentId,
  threadId: M.ThreadId.make("fixture-suggesting-thread"),
};
const space = Fixture.space;
const localRequest = { memorySpaceId: space, memoryId: Fixture.memoryId };
const hub = M.EnvironmentId.make("fixture-hub");
const forgetId = M.MemoryOperationId.make(Fixture.id(340));
const tombstone = {
  ...localRequest,
  deleteOperationId: forgetId,
  deletingEnvironmentId: hub,
  deletedAtUtc: M.MemoryUtcTimestamp.make("2026-01-01T00:00:00.000Z"),
  suppressedSourceKeys: [],
  suppressedContent: [],
  sourceExclusions: [],
};
const forget = {
  ...localRequest,
  protocolVersion: 1,
  kind: "forget",
  originEnvironmentId: hub,
  operationId: forgetId,
  expectedHeads: [],
  tombstone,
} satisfies M.MemoryOperation;

const installForgetCheckpoint = Effect.fn("test.installForgetCheckpoint")(function* () {
  const store = yield* Store.MemoryStore;
  const address = {
    memorySpaceId: space,
    hubEnvironmentId: hub,
    checkpointId: "fixture",
    expectedSnapshotToken: "fixture-token",
    expectedCheckpointSequence: 1,
  };
  yield* store.transact(
    store.advanceBootstrapTx({
      ...address,
      expectedState: "unbound",
      nextState: "staging",
      snapshotToken: address.expectedSnapshotToken,
      checkpointSequence: 1,
      nextCursor: null,
    }),
  );
  yield* store.installCheckpointPage({
    ...address,
    page: M.MemoryHubCheckpointPage.make({
      memorySpaceId: space,
      checkpointSequence: 1,
      retentionFloor: 0,
      causalBoundary: { checkpointSequence: 1, boundaryId: "fixture" },
      pageOrdinal: 0,
      tombstones: [tombstone],
      items: [],
      revisions: [],
      conflicts: [],
      resolutions: [],
      compactReceipts: [
        {
          memorySpaceId: space,
          originEnvironmentId: hub,
          operationKind: "forget",
          receipt: {
            outcome: "deleted",
            operationId: forgetId,
            memoryId: localRequest.memoryId,
            operationDigest: memoryOperationDigest(forget),
            hubSequence: 1,
          },
          revisionId: null,
          resolutionId: null,
          revertsResolutionId: null,
          attemptId: null,
          fencingToken: null,
          reportGuard: null,
        },
      ],
      identities: [
        {
          ...localRequest,
          scope: { kind: "user" },
          creatingEnvironmentId: hub,
          createOperationId: forgetId,
          createdAtUtc: tombstone.deletedAtUtc,
        },
      ],
      fences: [{ ...localRequest, highestFencingToken: 0, activeLease: null }],
      suppressions: [],
      importLineage: [],
      nextCursor: null,
      bootstrapComplete: true,
    }),
  });
  yield* store.completeCheckpoint({ ...address, pageCount: 1 });
});

it.effect.each(["local", "inbound", "checkpoint"] as const)(
  "a %s forget purges existing suggestions and drops an earlier refusal that reaches storage late",
  (path) =>
    Effect.gen(function* () {
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const suggestions = makeMemorySaveSuggestions({
        sql,
        store,
        requireSharing: () => Effect.void,
        stableUuid: Service.memoryStableUuid,
      });
      if (path === "local") yield* service.upsert(Fixture.upsert(), Effect.void);
      const candidate = (n: number) => ({
        input: { ...Fixture.upsert(n), memoryId: M.MemoryId.make(Fixture.id(n)) },
        thread: origin,
        knownRevisions: [],
        lineageComplete: false,
        forgetGeneration: 0,
        reason: "thread_lineage_incomplete" as const,
      });
      const before = candidate(341);
      const delayed = candidate(342);
      yield* suggestions.onRefusedSave(before, Effect.void);
      expect(yield* suggestions.listMetadata({ memorySpaceId: space }, Effect.void)).toHaveLength(
        1,
      );
      if (path === "local") yield* service.forget(localRequest, Effect.void);
      else if (path === "checkpoint") yield* installForgetCheckpoint();
      else
        yield* service.receiveHubPage({
          memorySpaceId: space,
          hubEnvironmentId: hub,
          localEnvironmentId: origin.environmentId,
          expectedSequence: 0,
          reauthorize: Effect.void,
          page: {
            highWatermark: 1,
            throughSequence: 1,
            hasMore: false,
            entries: [
              {
                kind: "operation",
                hubSequence: 1,
                operation: forget,
                receipt: {
                  outcome: "deleted",
                  operationDigest: memoryOperationDigest(forget),
                  operationId: forget.operationId,
                  memoryId: forget.memoryId,
                  hubSequence: 1,
                },
              },
            ],
          },
        });
      yield* suggestions.onRefusedSave(delayed, Effect.void);
      expect(yield* suggestions.listMetadata({ memorySpaceId: space }, Effect.void)).toEqual([]);
      expect(
        yield* sql`SELECT forget_generation FROM memory_space_counters WHERE space=${space}`,
      ).toEqual([{ forget_generation: 1 }]);
    }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("keeps an accepting suggestion when the pending queue reaches capacity", () =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const suggestions = makeMemorySaveSuggestions({
      sql,
      store,
      requireSharing: () => Effect.void,
      stableUuid: Service.memoryStableUuid,
    });
    const candidate = (n: number) => ({
      input: { ...Fixture.upsert(n), memoryId: M.MemoryId.make(Fixture.id(n)) },
      thread: origin,
      knownRevisions: [],
      lineageComplete: true,
      forgetGeneration: 0,
      reason: "capacity_exceeded" as const,
    });
    const first = candidate(500);
    yield* suggestions.onRefusedSave(first, Effect.void);
    const target = { memorySpaceId: space, suggestionId: first.input.memoryId };
    expect(yield* service.acceptSuggestion(target, Effect.void)).toEqual({ status: "pending" });
    for (let offset = 1; offset <= M.MEMORY_SAVE_SUGGESTION_MAX_ITEMS; offset++) {
      yield* suggestions.onRefusedSave(candidate(500 + offset), Effect.void);
    }
    const rows = yield* suggestions.listMetadata({ memorySpaceId: space }, Effect.void);
    expect(rows).toHaveLength(M.MEMORY_SAVE_SUGGESTION_MAX_ITEMS);
    expect(rows).toContainEqual(
      expect.objectContaining({ suggestionId: target.suggestionId, state: "accepting" }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({ suggestionId: candidate(501).input.memoryId }),
    );
  }).pipe(Effect.provide(Fixture.layer)),
);

it.effect("body-bearing suggestion requests require a person session even with memory grants", () =>
  Effect.gen(function* () {
    const memory = yield* Service.MemoryService;
    const input = { memorySpaceId: space, suggestionId: Fixture.memoryId };
    for (const principalKind of ["proxied_person", "outside_client"] as const) {
      const handlers = makeMemoryMutationHandlers(
        memory,
        { principalKind },
        Effect.void,
        Effect.void,
      );
      const errors = yield* Effect.all([
        handlers[M.WS_METHODS.memorySuggestionsList]({ memorySpaceId: space }).pipe(Effect.flip),
        handlers[M.WS_METHODS.memorySuggestionsAccept](input).pipe(Effect.flip),
        handlers[M.WS_METHODS.memorySuggestionsDismiss](input).pipe(Effect.flip),
      ]);
      expect(errors.map((error) => error.code)).toEqual([
        "unavailable",
        "unavailable",
        "unavailable",
      ]);
    }
  }).pipe(Effect.provide(Fixture.layer)),
);
