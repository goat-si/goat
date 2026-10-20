import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CheckpointAccountingError,
  refreshCheckpointAccounting,
} from "../../memory/MemoryCheckpointAccounting.ts";
import { runMigrations } from "../Migrations.ts";
import migration from "./085_MemoryCheckpointLifecycle.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const space = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA recursive_triggers=ON`;
  yield* sql`CREATE TABLE memory_quota_counters (
    space TEXT NOT NULL, dimension TEXT NOT NULL, scope_key TEXT NOT NULL,
    value INTEGER NOT NULL CHECK(value>=0), PRIMARY KEY(space,dimension,scope_key)
  )`;
  yield* sql`INSERT INTO memory_quota_counters VALUES
    (${space},'checkpoint_initialized','',1),(${space},'hub_snapshot_bytes','',0),(${space},'hub_snapshot_rows','',0),
    ('_hub_global','checkpoint_codec','',1)`;
});
const pending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    dimension: string;
  }>`SELECT dimension FROM memory_quota_counters WHERE space='_checkpoint_lifecycle' AND scope_key='' ORDER BY dimension`;
});

it.effect.each(["marker", "bytes", "rows", "marker-value"] as const)(
  "083 queues pre-upgrade %s corruption for the first refresh and retains evidence on rollback",
  (missing) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setup;
      if (missing === "marker-value")
        yield* sql`UPDATE memory_quota_counters SET value=2 WHERE space=${space} AND dimension='checkpoint_initialized'`;
      else {
        const dimension =
          missing === "marker" ? "checkpoint_initialized" : `hub_snapshot_${missing}`;
        yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND dimension=${dimension}`;
      }
      yield* sql.withTransaction(migration);
      assert.deepStrictEqual(yield* pending, [{ dimension: space }]);
      const failed = yield* sql.withTransaction(refreshCheckpointAccounting()).pipe(Effect.flip);
      assert.instanceOf(failed, CheckpointAccountingError);
      assert.strictEqual((failed as CheckpointAccountingError).stage, "missing-total");
      assert.deepStrictEqual(yield* pending, [{ dimension: space }]);
    }).pipe(Effect.provide(database)),
);

it.effect.each(["insert", "delete", "space", "dimension", "scope_key", "marker-value"] as const)(
  "083 tracks lifecycle %s changes without recursively tracking its own queue",
  (change) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* setup;
      yield* migration;
      yield* sql.withTransaction(refreshCheckpointAccounting());
      assert.deepStrictEqual(yield* pending, []);
      if (change === "insert")
        yield* sql`INSERT INTO memory_quota_counters VALUES (${other},'hub_snapshot_bytes','',0)`;
      else if (change === "delete")
        yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_rows'`;
      else if (change === "space")
        yield* sql`UPDATE memory_quota_counters SET space=${other} WHERE space=${space} AND dimension='hub_snapshot_rows'`;
      else if (change === "dimension")
        yield* sql`UPDATE memory_quota_counters SET dimension='other' WHERE space=${space} AND dimension='hub_snapshot_rows'`;
      else if (change === "scope_key")
        yield* sql`UPDATE memory_quota_counters SET scope_key='other' WHERE space=${space} AND dimension='hub_snapshot_rows'`;
      else
        yield* sql`UPDATE memory_quota_counters SET value=0 WHERE space=${space} AND dimension='checkpoint_initialized'`;
      assert.deepStrictEqual(
        yield* pending,
        (change === "space" ? [space, other] : [change === "insert" ? other : space]).map(
          (dimension) => ({ dimension }),
        ),
      );
      const failed = yield* sql.withTransaction(refreshCheckpointAccounting()).pipe(Effect.flip);
      assert.instanceOf(failed, CheckpointAccountingError);
      assert.strictEqual((failed as CheckpointAccountingError).stage, "missing-total");
    }).pipe(Effect.provide(database)),
);

it.effect("083 ignores ordinary total updates, unchanged markers and unrelated counters", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* setup;
    yield* migration;
    yield* sql.withTransaction(refreshCheckpointAccounting());
    yield* sql`UPDATE memory_quota_counters SET value=value+1 WHERE space=${space} AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows')`;
    yield* sql`UPDATE memory_quota_counters SET value=1 WHERE space=${space} AND dimension='checkpoint_initialized'`;
    yield* sql`UPDATE memory_quota_counters SET space=space,dimension=dimension,scope_key=scope_key WHERE space=${space}`;
    yield* sql`INSERT INTO memory_quota_counters VALUES (${space},'unrelated','',1),(${space},'hub_snapshot_bytes','private',1)`;
    yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND dimension='unrelated'`;
    assert.deepStrictEqual(yield* pending, []);
    yield* sql.withTransaction(refreshCheckpointAccounting());
    assert.deepStrictEqual(yield* pending, []);
  }).pipe(Effect.provide(database)),
);

it.effect("083 participates in the migration ledger and leaves healthy spaces unqueued", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 84 });
    yield* sql`INSERT INTO memory_quota_counters VALUES (${space},'checkpoint_initialized','',1),(${space},'hub_snapshot_bytes','',0),(${space},'hub_snapshot_rows','',0)`;
    assert.deepStrictEqual(yield* runMigrations(), [
      [85, "MemoryCheckpointLifecycle"],
      [86, "FleetGoals"],
      [87, "FleetHealth"],
      [88, "ThreadRunObservedChecks"],
      [89, "RemoteDispatchObservation"],
    ]);
    assert.deepStrictEqual(yield* pending, []);
    yield* sql.withTransaction(refreshCheckpointAccounting());
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* pending, []);
  }).pipe(Effect.provide(database)),
);
