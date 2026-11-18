import { expect, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Service from "../../../memory/MemoryService.ts";
import * as Store from "../../../memory/MemoryStore.ts";
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
      compactReceipts: [],
      identities: [],
      fences: [],
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
