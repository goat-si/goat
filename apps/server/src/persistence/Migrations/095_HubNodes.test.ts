import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades 090 with empty hub tables and retains their data on restart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 94 });
    expect(yield* runMigrations({ toMigrationInclusive: 95 })).toEqual([[95, "HubNodes"]]);
    const tables = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hub_node_%' ORDER BY name`;
    expect(tables.map((table) => table.name)).toEqual([
      "hub_node_imports",
      "hub_node_registrations",
      "hub_node_route_state",
    ]);
    yield* sql`INSERT INTO hub_node_registrations VALUES ('ssh:box', NULL, NULL, '{}', '{}', 'created', 'updated')`;
    yield* sql`INSERT INTO hub_node_route_state VALUES ('ssh:box', NULL, 'unknown', NULL, NULL, NULL)`;
    yield* sql`INSERT INTO hub_node_imports VALUES ('desktop-catalog', 'skipped_locked', 0, 'created', NULL)`;
    expect(yield* runMigrations({ toMigrationInclusive: 95 })).toEqual([]);
    expect(yield* sql`SELECT route_id, environment_id FROM hub_node_registrations`).toEqual([
      { route_id: "ssh:box", environment_id: null },
    ]);
    expect(yield* sql`SELECT status FROM hub_node_route_state`).toEqual([{ status: "unknown" }]);
    expect(yield* sql`SELECT outcome FROM hub_node_imports`).toEqual([
      { outcome: "skipped_locked" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
