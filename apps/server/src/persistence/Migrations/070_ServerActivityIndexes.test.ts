import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades schema 61 and maintains indexed background roster flags", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, provider, status, updated_at, payload_json) VALUES
    ('active-roster', 'claude', 'idle', '2026-10-11', '{"pendingBackgroundTasks":[{"taskId":"background","kind":"subagent"}]}'),
    ('empty-roster', 'claude', 'idle', '2026-10-11', '{}'),
    ('invalid-roster', 'claude', 'idle', '2026-10-11', 'invalid')`;
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 70 }), [
      [70, "ServerActivityIndexes"],
    ]);
    const read = () => sql<{ provider_thread_id: string; has_pending_background_work: number }>`
    SELECT provider_thread_id, has_pending_background_work FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id`;
    assert.deepStrictEqual(yield* read(), [
      { provider_thread_id: "active-roster", has_pending_background_work: 1 },
      { provider_thread_id: "empty-roster", has_pending_background_work: 0 },
      { provider_thread_id: "invalid-roster", has_pending_background_work: 0 },
    ]);
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{"pendingBackgroundTasks":[]}' WHERE provider_thread_id = 'active-roster'`;
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{"pendingBackgroundTasks":[{"taskId":"new"}]}' WHERE provider_thread_id = 'empty-roster'`;
    assert.deepStrictEqual(
      (yield* read()).map((row) => row.has_pending_background_work),
      [0, 1, 0],
    );
    const indexes = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_activity_idx'`;
    assert.strictEqual(indexes.length, 6);
    yield* runMigrations();
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
