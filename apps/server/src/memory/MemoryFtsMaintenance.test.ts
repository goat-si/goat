import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/076_Memory.ts";
import lineageMigration from "../persistence/Migrations/080_MemoryImportLineage.ts";
import hubMigration from "../persistence/Migrations/077_MemoryHubSync.ts";
import checkpointMigration from "../persistence/Migrations/081_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/093_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/082_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/083_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/084_MemoryRevertResults.ts";
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
describe("MemoryFtsMaintenance", () => {
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
