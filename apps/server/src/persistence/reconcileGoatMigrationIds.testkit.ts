import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DatabaseNewerThanBuildError } from "./Errors.ts";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import { GOAT_MIGRATION_NAMES } from "./reconcileGoatMigrationIds.ts";

// Builds before cycle 261114 recorded GOAT's migrations at 80-147. Upstream took 080-089, so GOAT's
// block moved to 90-157 and older ledgers move with it.
export const UPSTREAM_80S: ReadonlyArray<readonly [number, string]> = [
  [80, "ScheduledTaskThreadMode"],
  [81, "ProjectionMessageSearchText"],
  [82, "TurnItemConversationIndex"],
  [83, "CommandReadIndexes"],
  [84, "LastExecutedRunIndex"],
  [85, "TurnItemCounts"],
  [86, "QueuedTurnInputIndex"],
  [87, "ProjectionProjectsCustomTitle"],
  [88, "TurnItemTypeStatusIndex"],
  [89, "ShellThreadReadIndexes"],
];

export const isDatabaseNewerThanBuildError = Schema.is(DatabaseNewerThanBuildError);

export const goatNames = migrationEntries.flatMap(([, name]) =>
  GOAT_MIGRATION_NAMES.has(name) ? [name] : [],
);
export const currentRow = (name: string) => {
  const row = migrationManifest.find(([, entry]) => entry === name);
  if (row === undefined) throw new Error(`No migration named ${name}`);
  return row;
};

export const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

export const schema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
});

/** Upstream 1-79, then GOAT's migrations from 80 up to and including `oldMax`, as GOAT recorded them. */
export const seedOldGoatLedger = (oldMax: number) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          goatNames
            .slice(0, oldMax - 79)
            .flatMap((name, index) =>
              migrationEntries.flatMap(([, entry, migration]) =>
                entry === name ? [[`${80 + index}_${name}`, migration] as const] : [],
              ),
            ),
        ),
      ),
    });
  });

export const seedUserData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_payloads (space, payload_ref, memory_id, body_json, dependencies_json)
    VALUES ('space', 'ref', 'memory', '{"text":"keep"}', '[]')`;
  yield* sql`INSERT INTO scheduled_tasks (task_id,title,prompt,enabled,schedule_json,project_id,thread_id,workspace_strategy_json,model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,created_at,updated_at,last_run_status,run_count)
    VALUES ('task','Synthetic','Synthetic',1,'{}','project','thread','{}','{}','full-access','default','user','web','2026-11-01','2026-11-01','never',0)`;
});

export const userData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return [
    yield* sql`SELECT space, payload_ref, body_json FROM memory_payloads`,
    yield* sql`SELECT task_id, thread_id, title FROM scheduled_tasks`,
  ];
});
