import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./086_MemoryLastReadySpace.ts";

it.effect("081 rolls DDL back and preserves the retained destination across ledger reruns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 85 });
    const space = "00000000-0000-4000-8000-000000000001";
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture',0,'ready')`;
    const rollback = yield* sql
      .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.deepStrictEqual(rollback, Exit.fail("rollback"));
    assert.isEmpty(yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`);
    assert.deepStrictEqual(yield* runMigrations(), [
      [86, "MemoryLastReadySpace"],
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
    yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${space})`;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT singleton,space FROM memory_last_ready_space`, [
      { singleton: 1, space },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT bootstrap_state FROM memory_sync_cursors`, [
      { bootstrap_state: "ready" },
    ]);
    assert.isTrue(
      Exit.isFailure(
        yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (2,${space})`.pipe(
          Effect.exit,
        ),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
