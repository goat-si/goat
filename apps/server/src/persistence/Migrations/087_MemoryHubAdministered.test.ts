import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./087_MemoryHubAdministered.ts";

it.effect.each(["empty", "admin", "guard", "member", "last-ready"] as const)(
  "082 backfills durable administration from %s",
  (source) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Only the columns read by this migration: each historical source stands alone.
      yield* sql`CREATE TABLE memory_outbox(kind TEXT)`;
      yield* sql`CREATE TABLE memory_import_keys(key_kind TEXT)`;
      yield* sql`CREATE TABLE memory_hub_members(environment TEXT)`;
      yield* sql`CREATE TABLE memory_last_ready_space(space TEXT)`;
      if (source === "admin") yield* sql`INSERT INTO memory_outbox VALUES('admin')`;
      if (source === "guard") yield* sql`INSERT INTO memory_import_keys VALUES('hub_admin')`;
      if (source === "member") yield* sql`INSERT INTO memory_hub_members VALUES('fixture')`;
      if (source === "last-ready")
        yield* sql`INSERT INTO memory_last_ready_space VALUES('fixture')`;
      yield* migration;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_hub_administration_state`,
        source === "empty" ? [] : [{ singleton: 1, administered: 1 }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
it.effect("082 participates in the migration ledger and preserves its flag on rerun", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 86 });
    assert.deepStrictEqual(yield* runMigrations(), [
      [87, "MemoryHubAdministered"],
      [88, "MemoryCheckpointLifecycle"],
      [89, "FleetGoals"],
      [90, "FleetHealth"],
      [91, "ThreadRunObservedChecks"],
      [92, "RemoteDispatchObservation"],
      [93, "MemoryRevisionCheckpointSize"],
      [94, "HubNodes"],
      [95, "MemorySummaryWorkThreadIndex"],
      [96, "ThreadHistoryArchives"],
      [97, "PermissionProfiles"],
      [98, "DecisionInbox"],
      [99, "HumanStepRecords"],
    ]);
    yield* sql`INSERT INTO memory_hub_administration_state VALUES(1,1)`;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT administered FROM memory_hub_administration_state`, [
      { administered: 1 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
