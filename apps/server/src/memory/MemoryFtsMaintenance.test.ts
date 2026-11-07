import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/088_Memory.ts";
import lineageMigration from "../persistence/Migrations/092_MemoryImportLineage.ts";
import hubMigration from "../persistence/Migrations/089_MemoryHubSync.ts";
import checkpointMigration from "../persistence/Migrations/093_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/105_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/094_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/095_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/096_MemoryRevertResults.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Fts from "./MemoryFtsMaintenance.ts";
const env = M.EnvironmentId.make("fixture");
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
  ),
).pipe(Layer.provideMerge(database));
const live = Store.layer.pipe(Layer.provideMerge(setup));
const quotas = Quota.layer.pipe(Layer.provideMerge(live));
const services = Fts.layer.pipe(Layer.provideMerge(quotas));
const decodeMemoryOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const memoryOperation = decodeMemoryOperation({
  protocolVersion: 1,
  memorySpaceId: "00000000-0000-4000-8000-000000000001",
  memoryId: "00000000-0000-4000-8000-000000000002",
  operationId: "00000000-0000-4000-8000-000000000003",
  originEnvironmentId: env,
  expectedHeads: [],
  kind: "upsert",
  revision: {
    memorySpaceId: "00000000-0000-4000-8000-000000000001",
    memoryId: "00000000-0000-4000-8000-000000000002",
    revisionId: "00000000-0000-4000-8000-000000000004",
    operationId: "00000000-0000-4000-8000-000000000003",
    parents: [],
    scope: { kind: "user" },
    payloadRef: "00000000-0000-4000-8000-000000000004",
    assertionKind: "inference",
    provenance: { environmentId: env },
    createdAtUtc: "2026-10-14T00:00:00.000Z",
  },
  payload: { text: "new content", evidence: [], derivedFromMemoryRevisions: [] },
});
const seedHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json) VALUES ('fixture','item','{}','user','["head","other"]','active','current',0,'{}','{}')`;
  yield* sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,purge_eligible_after) VALUES ('fixture','current','item','current','[]',100000),('fixture','other','item','other','[]',100000),('fixture','conflict','item','conflict','[]',100000),('fixture','old','item','123456789','[]',100000)`;
  yield* sql`INSERT INTO memory_revisions (space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES ('fixture','head','item','op1','[]','{}','fact','{}','current',0),('fixture','other','item','op2','[]','{}','fact','{}','other',0),('fixture','conflict','item','op3','[]','{}','fact','{}','conflict',0)`;
  yield* sql`INSERT INTO memory_conflicts (space,conflict_id,memory_id,heads_json,status) VALUES ('fixture','conflict','item','["conflict"]','quarantined')`;
});
describe("MemoryFtsMaintenance", () => {
  it.effect("revert-window payloads are subtracted, current payloads are not", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      yield* seedHistory;
      const measured = yield* store.measureAllocation();
      yield* quota.recordStorageSample(env, undefined, measured);
      assert.strictEqual(
        (yield* store.storeBudgetBytes(env, 0)).bytes,
        measured.memoryUsedBytes! - 9,
      );
    }).pipe(Effect.provide(services)),
  );
  it.effect("a replaced payload that is still one of several heads is not subtracted", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const sql = yield* SqlClient.SqlClient;
      yield* seedHistory;
      yield* sql`DELETE FROM memory_payloads WHERE payload_ref='old'`;
      const measured = yield* store.measureAllocation();
      yield* quota.recordStorageSample(env, undefined, measured);
      assert.strictEqual((yield* store.storeBudgetBytes(env, 0)).bytes, measured.memoryUsedBytes);
    }).pipe(Effect.provide(services)),
  );
  it.effect(
    "a burst after a below-budget measurement is observed at the next pressure sample",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const allocation = yield* store.measureAllocation();
        let used = M.MEMORY_STORE_TARGET_BYTES;
        const probe = Store.MemoryStore.of({
          ...store,
          measureAllocation: () =>
            Clock.currentTimeMillis.pipe(
              Effect.map((measuredAt) => ({
                ...allocation,
                measuredAt,
                memoryBytes: used,
                memoryUsedBytes: used,
              })),
            ),
        });
        const quota = yield* Quota.MemoryQuotaService.pipe(
          Effect.provide(Layer.fresh(Quota.layer)),
          Effect.provideService(Store.MemoryStore, probe),
        );
        const maintenance = yield* Fts.MemoryFtsMaintenance.pipe(
          Effect.provide(Layer.fresh(Fts.layer)),
          Effect.provideService(Store.MemoryStore, probe),
          Effect.provideService(Quota.MemoryQuotaService, quota),
        );
        yield* maintenance.cycle(env);
        if (memoryOperation.kind !== "upsert") throw new Error("Fixture must be an upsert");
        const op = memoryOperation;
        yield* quota.commit(
          {
            operation: op,
            operationDigest: "a".repeat(64),
            admission: Store.localIntent,
            receipt: {
              operationId: op.operationId,
              memoryId: op.memoryId,
              pendingSync: true,
              revisionId: op.revision.revisionId,
              outcome: "accepted",
            },
            item: {
              memorySpaceId: op.memorySpaceId,
              memoryId: op.memoryId,
              status: "active",
              scope: op.revision.scope,
              revision: op.revision,
              payload: op.payload,
              pendingSync: true,
              localAvailability: {
                exposure: "visible",
                reasons: [],
                deferred: [],
                cleanupPending: false,
              },
            } as M.MemoryItem,
          },
          env,
          Effect.void,
        );
        used = M.MEMORY_STORE_BUDGET_BYTES;
        yield* TestClock.adjust(300_000);
        yield* maintenance.cycle(env);
        assert.strictEqual((yield* store.storeBudgetBytes(env, 300_000)).bytes, used);
        const grown = decodeMemoryOperation({
          ...op,
          operationId: "00000000-0000-4000-8000-000000000005",
          revision: { ...op.revision, operationId: "00000000-0000-4000-8000-000000000005" },
          payload: { ...op.payload, text: "a longer memory after the burst" },
        });
        const refused = yield* Effect.flip(
          quota.withAdmission(
            { operation: grown, admission: Store.localIntent, environmentId: env },
            Effect.void,
          ),
        );
        assert.deepInclude(refused, { _tag: "MemoryCapacityError", current: used });
      }).pipe(Effect.provide(services)),
  );
  it.effect("failed and delayed sampling falls back after the figure expires", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const measured = yield* store.measureAllocation();
      yield* quota.recordStorageSample(env, undefined, {
        ...measured,
        memoryBytes: M.MEMORY_STORE_BUDGET_BYTES,
      });
      yield* TestClock.adjust(7_200_001);
      const probe = Store.MemoryStore.of({
        ...store,
        measureAllocation: () =>
          Effect.fail(
            new Store.MemoryStorageError({ stage: "test-measurement", cause: undefined }),
          ),
      });
      const maintenance = yield* Fts.MemoryFtsMaintenance.pipe(
        Effect.provide(Layer.fresh(Fts.layer)),
        Effect.provideService(Store.MemoryStore, probe),
      );
      assert.strictEqual((yield* Effect.exit(maintenance.cycle(env)))._tag, "Failure");
      assert.strictEqual(
        (yield* store.storeBudgetBytes(env, 7_200_001)).bytes,
        M.MEMORY_STORE_BUDGET_BYTES,
      );
    }).pipe(Effect.provide(services)),
  );
  it.effect("a delayed measurement is not made fresh when it is recorded", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const quota = yield* Quota.MemoryQuotaService;
      const measured = yield* store.measureAllocation();
      yield* TestClock.adjust(7_200_001);
      yield* quota.recordStorageSample(env, undefined, {
        ...measured,
        memoryBytes: M.MEMORY_STORE_BUDGET_BYTES,
      });
      assert.strictEqual(
        (yield* store.storeBudgetBytes(env, 7_200_001)).bytes,
        M.MEMORY_STORE_BUDGET_BYTES,
      );
    }).pipe(Effect.provide(services)),
  );
  it.effect("throttles completed unavailable allocation attempts until the sample deadline", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const allocation = yield* store.measureAllocation();
      let measurements = 0;
      const probe = Store.MemoryStore.of({
        ...store,
        measureAllocation: () =>
          Effect.sync(() => {
            measurements++;
            return { ...allocation, memoryBytes: null, ftsBytes: null };
          }),
        mergeFts: () => Effect.succeed(false),
      });
      const maintenance = yield* Fts.MemoryFtsMaintenance.pipe(
        Effect.provide(Layer.fresh(Fts.layer)),
        Effect.provideService(Store.MemoryStore, probe),
      );
      const first = yield* maintenance.cycle(env);
      const second = yield* maintenance.cycle(env);
      assert.equal(first.measurementStatus, "unavailable");
      assert.isNull((yield* store.storeBudgetBytes(env, 0)).bytes);
      assert.isNull(first.lastMeasuredAtUtc);
      assert.deepEqual(second, first);
      assert.equal(measurements, 1);
      yield* TestClock.adjust(Fts.MEMORY_STORAGE_SAMPLE_INTERVAL_MS - 1);
      yield* maintenance.cycle(env);
      assert.equal(measurements, 1);
      yield* TestClock.adjust(1);
      yield* maintenance.cycle(env);
      assert.equal(measurements, 2);
      assert.isNull((yield* store.ftsState(env)).measuredAt);
    }).pipe(Effect.provide(services)),
  );
  it.effect("measures complete real dbstat inventory and performs bounded merge", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const maintenance = yield* Fts.MemoryFtsMaintenance;
      for (let row = 1; row <= 100; row++)
        yield* sql`INSERT INTO memory_items_fts (rowid,body) VALUES (${row},${`synthetic token${row}`})`;
      const measured = yield* store.measureAllocation();
      assert.isNotNull(measured.memoryBytes);
      assert.isNotNull(measured.ftsBytes);
      assert.isAbove(measured.ftsBytes!, 0);
      yield* maintenance.markChanged(env, M.MEMORY_FTS_MERGE_TRIGGER_CHANGES);
      yield* maintenance.cycle(env);
      assert.isNotNull((yield* store.ftsState(env)).lastMergeAt);
      assert.strictEqual((yield* sql`SELECT body FROM memory_items_fts`).length, 100);
    }).pipe(Effect.provide(services)),
  );
  it.effect(
    "persists brake across restart and resumes only after measured successful maintenance",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const maintenance = yield* Fts.MemoryFtsMaintenance;
        yield* store.putFtsState({
          ...(yield* store.ftsState(env)),
          state: "braked",
          allocatedBytes: M.MEMORY_FTS_ALLOCATED_BRAKE_BYTES,
          measurementStatus: "available",
          measuredAt: 0,
          mergePending: true,
        });
        const restored = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.strictEqual((yield* restored.ftsState(env)).state, "braked");
        const refreshed = yield* maintenance.cycle(env);
        assert.strictEqual(refreshed.state, "open");
        assert.isBelow(refreshed.allocatedBytes!, M.MEMORY_FTS_ALLOCATED_RESUME_BYTES);
      }).pipe(Effect.provide(services)),
  );
  it.effect("missing dbstat preserves brake and exposes unavailable measurement", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* Fts.MemoryFtsMaintenance;
      yield* store.putFtsState({
        ...(yield* store.ftsState(env)),
        state: "braked",
        mergePending: true,
      });
      yield* sql`CREATE TABLE dbstat (unavailable INTEGER)`;
      const state = yield* maintenance.cycle(env);
      assert.strictEqual(state.state, "braked");
      assert.strictEqual(state.measurementStatus, "unavailable");
      assert.isNull(state.allocatedBytes);
    }).pipe(Effect.provide(services)),
  );
  it.effect("FTS unavailable does not prevent canonical migration or metrics", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE memory_items_fts`;
      assert.isFalse(yield* store.mergeFts());
      assert.isAbove((yield* store.measureAllocation()).dbFileBytes, 0);
      assert.strictEqual((yield* sql`SELECT * FROM memory_items`).length, 0);
    }).pipe(Effect.provide(services)),
  );
  it.effect("sampled brake is persisted before its status is published", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const metrics = yield* store.measureAllocation();
      const probe = Store.MemoryStore.of({
        ...store,
        measureAllocation: () =>
          Effect.succeed({
            ...metrics,
            memoryBytes: M.MEMORY_FTS_ALLOCATED_BRAKE_BYTES,
            ftsBytes: M.MEMORY_FTS_ALLOCATED_BRAKE_BYTES,
          }),
        mergeFts: () => Effect.succeed(false),
      });
      const maintenance = yield* Fts.MemoryFtsMaintenance.pipe(
        Effect.provide(Layer.fresh(Fts.layer)),
        Effect.provideService(Store.MemoryStore, probe),
      );
      const state = yield* maintenance.cycle(env);
      assert.strictEqual(state.state, "braked");
      assert.strictEqual((yield* store.ftsState(env)).state, "braked");
      assert.strictEqual((yield* store.ftsState(env)).mergePending, true);
    }).pipe(Effect.provide(services)),
  );
});
