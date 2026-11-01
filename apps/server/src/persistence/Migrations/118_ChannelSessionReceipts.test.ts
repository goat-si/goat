import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("118_ChannelSessionReceipts", (it) => {
  it.effect(
    "upgrades an existing database without changing channel ownership and keeps held event order durable",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 117 });
        yield* sql`INSERT INTO channel_runtime_state (key, owner_token, value_json, updated_at)
        VALUES ('worker', 'previous-owner', '{}', '2026-10-29T00:00:00.000Z')`;
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 118 }), [
          [118, "ChannelSessionReceipts"],
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT owner_token FROM channel_runtime_state WHERE key = 'worker'`,
          [{ owner_token: "previous-owner" }],
        );
        yield* sql`INSERT INTO session_held_provider_events (run_id, task_id, task_generation, sequence, event_json)
        VALUES ('run', 'task', 1, 2, '{"id":"second"}'), ('run', 'task', 1, 1, '{"id":"first"}')`;
        assert.deepStrictEqual(
          yield* sql`SELECT event_json FROM session_held_provider_events ORDER BY sequence`,
          [{ event_json: '{"id":"first"}' }, { event_json: '{"id":"second"}' }],
        );
        const duplicate = yield* sql`INSERT INTO session_held_provider_events
        (run_id, task_id, task_generation, sequence, event_json) VALUES ('run', 'task', 1, 1, '{}')`.pipe(
          Effect.result,
        );
        assert.strictEqual(duplicate._tag, "Failure");
        assert.deepStrictEqual(yield* sql`SELECT * FROM channel_session_receipts`, []);
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 118 }), []);
      }),
  );
});
