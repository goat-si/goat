// @effect-diagnostics nodeBuiltinImport:off - copies the historical packaged-app fixture into a scoped temp directory.
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";

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
    yield* runMigrations({ toMigrationInclusive: 70 });
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 70 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("migrates the packaged launch fixture through 122 and preserves its thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-release-fixture-" });
    const dbPath = `${directory}/statev2.sqlite`;
    yield* fs.copyFile(
      NodeURL.fileURLToPath(
        new URL("../../../../../scripts/fixtures/desktop-launch/statev2.sqlite", import.meta.url),
      ),
      dbPath,
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* runMigrations({ toMigrationInclusive: 122 }),
        migrationManifest.filter(([id]) => id > 69 && id <= 122),
      );
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 122 }), []);
      const recorded = yield* sql<{ migration_id: number; name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepStrictEqual(
        recorded.map((row) => [row.migration_id, row.name] as const),
        migrationManifest.filter(([id]) => id <= 122),
      );
      const columns = yield* sql<{
        name: string;
      }>`PRAGMA table_xinfo(orchestration_v2_projection_provider_threads)`;
      assert.isTrue(columns.some((column) => column.name === "has_pending_background_work"));
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* store.getThreadProjection(ThreadId.make("launch-check-thread"));
      assert.equal(projection.thread.title, "Release launch check");
      assert.isTrue(
        projection.messages.some(
          (message) => message.text === "The release opens and shows this thread.",
        ),
      );
      for (const table of [
        "auth_sessions",
        "provider_session_runtime",
        "scheduled_tasks",
        "scheduled_task_runs",
        "orchestration_v2_projection_provider_sessions",
        "orchestration_v2_projection_runs",
        "orchestration_v2_effect_outbox",
      ]) {
        const rows = yield* sql.unsafe<{ count: number }>(
          `SELECT count(*) AS count FROM "${table}"`,
        );
        assert.equal(rows[0]?.count, 0, `${table} must stay empty during migration`);
      }
    }).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
