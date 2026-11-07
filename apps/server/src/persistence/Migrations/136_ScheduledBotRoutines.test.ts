import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("adds the routine owner column and a link table that outlives deleted routines", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 135 });
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 136 }), [
      [136, "ScheduledBotRoutines"],
    ]);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
    assert.isTrue(columns.some((column) => column.name === "owner_json"));
    yield* sql`INSERT INTO scheduled_task_channel_inputs
      (firing_id, task_id, input_id, payload_json, state, created_at)
      VALUES ('f1', 't1', 'i1', '{}', 'pending', 'now')`;
    // No foreign key: deleting the routine leaves the link that marks its input as a routine.
    yield* sql`DELETE FROM scheduled_tasks WHERE task_id = 't1'`;
    const links = yield* sql<{
      input_id: string;
    }>`SELECT input_id FROM scheduled_task_channel_inputs`;
    assert.deepStrictEqual(links, [{ input_id: "i1" }]);
    const duplicate = yield* sql`INSERT INTO scheduled_task_channel_inputs
      (firing_id, task_id, input_id, payload_json, state, created_at)
      VALUES ('f2', 't1', 'i1', '{}', 'pending', 'now')`.pipe(Effect.flip);
    assert.isDefined(duplicate);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
