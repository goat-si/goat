import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrateDevDb } from "./migrate-dev-db.ts";
import { createFixtureSource, withDatabase } from "./migrate-dev-db.testkit.ts";

it.layer(NodeServices.layer)("migrate-dev-db and the developer's machines", (it) => {
  it.effect("regression: drops every record that points the copy at the developer's machines", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO hub_node_registrations
            (route_id, environment_id, label, target_json, added_by_json, created_at, updated_at)
            VALUES ('route-1', 'env-macmini', 'macmini-ts', '{"kind":"ssh","alias":"macmini-ts"}',
              '{"kind":"person"}', '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO hub_node_route_state (route_id, environment_id, status)
            VALUES ('route-1', 'env-macmini', 'online')`;
          yield* sql`INSERT INTO hub_node_imports (source, outcome, imported, at)
            VALUES ('desktop-catalog', 'imported', 1, '2026-08-01')`;
          yield* sql`INSERT INTO hub_provisioned_links (alias, link_id) VALUES ('mini', 'link-1')`;
          yield* sql`INSERT INTO remote_dispatches
            (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, created_at, updated_at)
            VALUES ('dispatch-1', 'thread', 'stopped-thread', 'mac-studio', 'key', 'wake', 'running',
              '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO remote_relay_requests (correlation_id, client_request_id, sequence)
            VALUES ('dispatch-1', 'request-1', 1)`;
          yield* sql`INSERT INTO fleet_goals
            (id, owner_key, owner_json, title, spec_json, generation, status_json, phase, created_at, updated_at)
            VALUES ('goal-1', 'owner', '{}', 'Goal', '{}', 1, '{}', 'running', '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO fleet_goal_workers
            (goal_id, slot, attempt, host, model_json, state, launch_client_request_id, tried_json, detail_json, updated_at)
            VALUES ('goal-1', 0, 1, 'lidge-ts', '{}', 'running', 'launch-1', '[]', '{}', '2026-08-01')`;
          yield* sql`INSERT INTO fleet_goal_events (goal_id, seq, at, type, reason, message)
            VALUES ('goal-1', 1, '2026-08-01', 'launched', 'launch', 'started')`;
          yield* sql`INSERT INTO fleet_goal_actions (action_id, goal_id, generation, kind, host, claimed_at)
            VALUES ('action-1', 'goal-1', 1, 'launch', 'lidge-ts', '2026-08-01')`;
          yield* sql`INSERT INTO fleet_reschedule_claims
            (client_request_id, owner_key, target_host, title, branch, claimed_at)
            VALUES ('claim-1', 'owner', 'clisu-oracle', 'Goal', 'main', '2026-08-01')`;
          yield* sql`INSERT INTO fleet_host_states (host, cordoned, draining, changed_at)
            VALUES ('mini', 1, 0, '2026-08-01')`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      const counts = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tables = [
            "hub_node_registrations",
            "hub_node_route_state",
            "hub_provisioned_links",
            "remote_dispatches",
            "remote_relay_requests",
            "fleet_goals",
            "fleet_goal_workers",
            "fleet_goal_events",
            "fleet_goal_actions",
            "fleet_reschedule_claims",
            // Kept: an import marker stops a re-import, and cordon flags dial nothing.
            "hub_node_imports",
            "fleet_host_states",
            "remote_reports",
          ];
          const entries = yield* Effect.forEach(tables, (table) =>
            sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`.pipe(
              Effect.map(([row]) => [table, Number(row?.count)] as const),
            ),
          );
          return Object.fromEntries(entries);
        }),
      );
      assert.deepStrictEqual(counts, {
        hub_node_registrations: 0,
        hub_node_route_state: 0,
        hub_provisioned_links: 0,
        remote_dispatches: 0,
        remote_relay_requests: 0,
        fleet_goals: 0,
        fleet_goal_workers: 0,
        fleet_goal_events: 0,
        fleet_goal_actions: 0,
        fleet_reschedule_claims: 0,
        hub_node_imports: 1,
        fleet_host_states: 1,
        remote_reports: 2,
      });
    }),
  );
});
