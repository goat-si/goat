import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrateDevDb } from "./migrate-dev-db.ts";
import { createFixtureSource, withDatabase } from "./migrate-dev-db.testkit.ts";

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("imports a dev seed whose ids after 67 came from the peer links branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-peer-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-peer-dest-" });
      const source = yield* createFixtureSource(sourceDir, 67);
      // Mirrors a legacy seed written by a build whose 68-70 differ from main's.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE peer_environment_links (
            environment_id TEXT PRIMARY KEY,
            secret_name TEXT NOT NULL,
            label TEXT NOT NULL,
            urls_json TEXT NOT NULL,
            access TEXT NOT NULL,
            linked_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_reached_at TEXT,
            last_error TEXT,
            fenced INTEGER NOT NULL DEFAULT 0)`;
          yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_waiting_link_idx
            ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, turn_item_id DESC)
            WHERE type = 'link_request' AND status = 'waiting'`;
          yield* sql`INSERT INTO peer_environment_links
            (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
            VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto',
              '2026-08-01', '2027-08-01')`;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (68, 'PeerLinks'), (69, 'PeerLinkFence'), (70, 'WaitingLinkRequestIndex')`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      const imported = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const schema = yield* sql<{ name: string }>`
            SELECT name FROM sqlite_master WHERE name IN (
              'orchestration_v2_projection_turn_items_stop_request_idx',
              'orchestration_v2_message_search')
            ORDER BY name`;
          return { threads, schema };
        }),
      );
      assert.deepStrictEqual(
        imported.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        imported.schema.map((row) => row.name),
        [
          "orchestration_v2_message_search",
          "orchestration_v2_projection_turn_items_stop_request_idx",
        ],
      );
    }),
  );
});
