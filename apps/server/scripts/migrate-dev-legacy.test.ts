import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../src/persistence/Migrations.ts";
import { runMigrateDevDb } from "./migrate-dev-db.ts";
import { createFixtureSource, withDatabase } from "./migrate-dev-db.testkit.ts";

it.layer(NodeServices.layer)("legacy dev seed", (it) => {
  it.effect.each([
    { name: "a pre-V2 source", migrateToLatest: false },
    { name: "a V2 source whose legacy threads were never imported", migrateToLatest: true },
  ])("refuses $name without changing the destination WAL", ({ migrateToLatest }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-legacy-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-legacy-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 54 });
          yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('project-legacy', 'Legacy', '/tmp/legacy', '[]', '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
          VALUES ('thread-legacy', 'project-legacy', 'Legacy thread',
            '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-08-01', '2026-08-01')`;
          if (migrateToLatest) yield* runMigrations();
        }),
      );
      const destination = yield* createFixtureSource(destDir);
      yield* withDatabase(
        destination,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
          yield* sql`UPDATE projection_projects SET title = 'Edited' WHERE project_id = 'project-kept'`;
          const walBefore = yield* fs.readFile(`${destination}-wal`);
          assert.isAbove(walBefore.length, 0);
          const error = yield* runMigrateDevDb(
            { baseDir: destDir, source, projects: 1, threadsPerProject: 10 },
            { sharedHome: sourceDir },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "MigrateDevDbLegacySourceError");
          assert.deepStrictEqual(yield* fs.readFile(`${destination}-wal`), walBefore);
        }),
      );
    }),
  );
  it.effect("copies an already imported legacy thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-imported-source-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-imported-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE orchestration_events SET application_event_version = 2 WHERE stream_id = 'stopped-thread'`;
          yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
          VALUES ('stopped-thread', 'project-kept', 'stopped-thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-08-01', '2026-08-01')`;
        }),
      );
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      const rows = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = 'stopped-thread'`;
        }),
      );
      assert.deepStrictEqual(
        rows.map((row) => row.thread_id),
        ["stopped-thread"],
      );
    }),
  );
});
