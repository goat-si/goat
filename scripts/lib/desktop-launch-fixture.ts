// @effect-diagnostics nodeBuiltinImport:off - release probes inspect only their copied SQLite fixture.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

// Upstream f41518f3bc's invented history, sanitized to remove its fixed workspace path.
// Keep its ledger through 69 so the packaged server, rather than this probe, runs GOAT's migrations.
export const DESKTOP_LAUNCH_FIXTURE = NodePath.resolve(
  import.meta.dirname,
  "../fixtures/desktop-launch/statev2.sqlite",
);
export const LAUNCH_THREAD_TITLE = "Release launch check";
export const LAUNCH_THREAD_MESSAGE = "The release opens and shows this thread.";

const emptyFixtureTables = [
  "auth_sessions",
  "auth_pairing_links",
  "provider_session_runtime",
  "projection_thread_sessions",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_session_bindings",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_v2_effect_outbox",
  "scheduled_tasks",
  "scheduled_task_webhook_pending",
  "scheduled_task_webhook_deliveries",
  "scheduled_task_webhook_relay_deliveries",
] as const;

export function assertSafeDesktopFixture(database: NodeSqlite.DatabaseSync) {
  for (const table of emptyFixtureTables) {
    if (database.prepare(`SELECT count(*) AS count FROM "${table}"`).get()?.count !== 0) {
      throw new Error(`Unsafe desktop launch fixture: ${table} must be empty.`);
    }
  }
  if (
    database.prepare("SELECT max(migration_id) AS id FROM effect_sql_migrations").get()?.id !== 69
  ) {
    throw new Error("Desktop launch fixture must stop at migration 69.");
  }
  const thread = database
    .prepare("SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ?")
    .get("launch-check-thread");
  const message = database
    .prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE message_id = ?")
    .get("launch-check-assistant");
  if (
    thread?.title !== LAUNCH_THREAD_TITLE ||
    typeof message?.payload_json !== "string" ||
    !message.payload_json.includes(LAUNCH_THREAD_MESSAGE)
  ) {
    throw new Error("Desktop launch fixture is missing its seeded thread history.");
  }
}

export function prepareDesktopLaunchHome(scratch: string) {
  const home = NodePath.join(scratch, "goat");
  const dbPath = NodePath.join(home, "userdata/statev2.sqlite");
  const workspace = NodePath.join(scratch, "workspace");
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  NodeFS.mkdirSync(workspace);
  NodeFS.copyFileSync(DESKTOP_LAUNCH_FIXTURE, dbPath);
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    assertSafeDesktopFixture(database);
    database
      .prepare("UPDATE projection_projects SET workspace_root = ? WHERE project_id = ?")
      .run(workspace, "launch-check-project");
  } finally {
    database.close();
  }
  return { home, dbPath };
}

export function assertDesktopLaunchMigrated(dbPath: string) {
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const activity = database
      .prepare("SELECT migration_id FROM effect_sql_migrations WHERE name = ?")
      .get("ServerActivityIndexes");
    if (typeof activity?.migration_id !== "number" || activity.migration_id <= 69) {
      throw new Error("The packaged server did not apply GOAT's migrations after 69.");
    }
    database
      .prepare(
        "SELECT has_pending_background_work FROM orchestration_v2_projection_provider_threads",
      )
      .all();
    return database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
  } finally {
    database.close();
  }
}
