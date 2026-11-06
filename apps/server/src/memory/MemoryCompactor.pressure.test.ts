import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import * as Store from "./MemoryStore.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";
import {
  space,
  memoryId,
  hubEnv,
  core,
  memberEnv,
  principal,
  live,
  seed,
  push,
} from "./MemoryCompactor.testkit.ts";

// Fixture operations carry this creation time; events age from it, hub operations from the clock.
const fixtureTime = Date.parse("2026-10-14T00:00:00.000Z");

describe("MemoryCompactor pressure", () => {
  it.effect("pressure compaction keeps the event an undelivered report still reads", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(fixtureTime);
      yield* seed;
      const accepted = yield* push();
      const operationId = accepted.receipts[0]!.operationId;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolving_environment_id,outcome,state,created_at) VALUES ('pressure-report',${space},${memoryId},${operationId},${hubEnv},'failed','pending',0)`;
      yield* TestClock.adjust(86_400_001);
      const store = yield* Store.MemoryStore;
      const observed = Store.MemoryStore.of({
        ...store,
        storeBudgetBytes: () =>
          Effect.succeed({ bytes: M.MEMORY_STORE_TARGET_BYTES, basis: "used" as const }),
      });
      const compactor = yield* Compactor.make.pipe(
        Effect.provideService(Store.MemoryStore, observed),
        Effect.provideService(Hub.MemoryHubConfiguration, {
          read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
        }),
      );
      yield* compactor.reclaim(principal());
      assert.lengthOf(yield* sql`SELECT 1 FROM memory_events WHERE operation_id=${operationId}`, 1);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_hub_operations WHERE operation_id=${operationId}`,
        0,
      );
    }).pipe(Effect.provide(live)),
  );
  it.effect("a lagging member bootstraps after pressure compaction and converges", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* push();
      yield* TestClock.adjust(86_400_001);
      const store = yield* Store.MemoryStore;
      const observed = Store.MemoryStore.of({
        ...store,
        storeBudgetBytes: () =>
          Effect.succeed({ bytes: M.MEMORY_STORE_TARGET_BYTES, basis: "used" as const }),
      });
      const compactor = yield* Compactor.make.pipe(
        Effect.provideService(Store.MemoryStore, observed),
        Effect.provideService(Hub.MemoryHubConfiguration, {
          read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
        }),
      );
      const result = yield* compactor.compact(principal());
      assert.isAbove(result.compaction.removedRows, 0);
      const hub = yield* Hub.MemoryHubService;
      const joined = yield* hub.join(
        { protocolVersion: 1, memorySpaceId: space, environmentId: memberEnv },
        principal(memberEnv),
      );
      const pulled = yield* hub.pull(
        {
          protocolVersion: 1,
          memorySpaceId: space,
          environmentId: memberEnv,
          afterSequence: 0,
          limit: 100,
          snapshotToken: joined.snapshotToken,
        },
        principal(memberEnv),
      );
      const page = pulled.checkpoint!;
      yield* Effect.gen(function* () {
        const replica = yield* Store.MemoryStore;
        const input = {
          memorySpaceId: space,
          hubEnvironmentId: hubEnv,
          checkpointId: "pressure-replica",
          expectedSnapshotToken: "pressure-token",
          expectedCheckpointSequence: page.checkpointSequence,
        };
        yield* replica.transact(
          replica.advanceBootstrapTx({
            ...input,
            expectedState: "unbound",
            nextState: "staging",
            snapshotToken: input.expectedSnapshotToken,
            checkpointSequence: input.expectedCheckpointSequence,
            nextCursor: null,
          }),
        );
        yield* replica.installCheckpointPage({ ...input, page });
        yield* replica.completeCheckpoint({ ...input, pageCount: 1 });
        const original = yield* store.loadAggregate(space, memoryId, { heads: true });
        const recovered = yield* replica.loadAggregate(space, memoryId, { heads: true });
        assert.deepStrictEqual(recovered.heads, original.heads);
        const headPayloads = (aggregate: typeof original) =>
          aggregate.revisions
            .filter((pair) => aggregate.heads.includes(pair.revision.revisionId))
            .map((pair) => pair.payload);
        assert.deepStrictEqual(headPayloads(recovered), headPayloads(original));
        assert.isNotEmpty(headPayloads(recovered));
      }).pipe(Effect.provide(Layer.fresh(core)));
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("a page of uncovered candidates does not hide covered rows behind it", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<256) INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) SELECT ${space},printf('00000000-0000-4000-8000-%012d',i+100000),${memoryId},${hubEnv},${"c".repeat(64)},'{}',0 FROM n`;
      const accepted = yield* push();
      yield* TestClock.adjust(86_400_001);
      const store = yield* Store.MemoryStore;
      const observed = Store.MemoryStore.of({
        ...store,
        storeBudgetBytes: () =>
          Effect.succeed({ bytes: M.MEMORY_STORE_TARGET_BYTES, basis: "used" as const }),
      });
      const compactor = yield* Compactor.make.pipe(
        Effect.provideService(Store.MemoryStore, observed),
        Effect.provideService(Hub.MemoryHubConfiguration, {
          read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
        }),
      );
      yield* compactor.reclaim(principal());
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_hub_operations WHERE operation_id=${accepted.receipts[0]!.operationId}`,
        0,
      );
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_hub_operations WHERE space=${space}`)[0]!.count,
        256,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("a live checkpoint handle holds the floor during pressure compaction", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const hub = yield* Hub.MemoryHubService;
      const observed = Store.MemoryStore.of({
        ...store,
        storeBudgetBytes: () =>
          Effect.succeed({ bytes: M.MEMORY_STORE_TARGET_BYTES, basis: "used" as const }),
      });
      const compactor = yield* Compactor.make.pipe(
        Effect.provideService(Store.MemoryStore, observed),
        Effect.provideService(Hub.MemoryHubConfiguration, {
          read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
        }),
      );
      yield* compactor.compact(principal());
      yield* TestClock.adjust(86_400_001);
      yield* hub.join(
        { protocolVersion: 1, memorySpaceId: space, environmentId: memberEnv },
        principal(memberEnv),
      );
      yield* push();
      const status = yield* compactor.compact(principal());
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(status.retentionFloor, 0);
      assert.include(status.compaction.blockedReasons, "checkpoint_pinned");
      assert.lengthOf(yield* sql`SELECT 1 FROM memory_hub_operations WHERE space=${space}`, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("under target the 30-day log retention still applies", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* push();
      yield* TestClock.adjust(86_400_001);
      const status = yield* (yield* Compactor.MemoryCompactor).compact(principal());
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual(status.compaction.removedRows, 0);
      assert.lengthOf(yield* sql`SELECT 1 FROM memory_hub_operations WHERE space=${space}`, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "over target, pressure compaction removes covered day-old operations and keeps current state",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(fixtureTime);
        yield* seed;
        const receipt = yield* push();
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const observed = Store.MemoryStore.of({
          ...store,
          storeBudgetBytes: () =>
            Effect.succeed({ bytes: M.MEMORY_STORE_TARGET_BYTES, basis: "used" as const }),
        });
        const compactor = yield* Compactor.make.pipe(
          Effect.provideService(Store.MemoryStore, observed),
          Effect.provideService(Hub.MemoryHubConfiguration, {
            read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
          }),
        );
        const before =
          yield* sql`SELECT heads_json,payload_ref FROM memory_items WHERE space=${space}`;
        yield* TestClock.adjust(86_400_001);
        const status = yield* compactor.compactIfNeeded(principal());
        assert.isAbove(status.compaction.removedRows, 0);
        assert.deepStrictEqual(
          yield* sql`SELECT heads_json,payload_ref FROM memory_items WHERE space=${space}`,
          before,
        );
        assert.lengthOf(yield* sql`SELECT 1 FROM memory_hub_operations WHERE space=${space}`, 0);
        assert.lengthOf(yield* sql`SELECT 1 FROM memory_events WHERE memory_space_id=${space}`, 0);
        assert.lengthOf(yield* sql`SELECT 1 FROM memory_compact_receipts WHERE space=${space}`, 1);
        assert.lengthOf(yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space}`, 1);
        assert.deepStrictEqual(yield* push(), receipt);
      }).pipe(checkUsage, Effect.provide(live)),
  );
});
