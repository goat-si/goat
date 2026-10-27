// @effect-diagnostics nodeBuiltinImport:off - exercises the release fixture on disposable SQLite copies.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "vite-plus/test";
import {
  assertDesktopLaunchMigrated,
  assertSafeDesktopFixture,
  DESKTOP_LAUNCH_FIXTURE,
  prepareDesktopLaunchHome,
} from "./desktop-launch-fixture.ts";

function scratchDirectory() {
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-test-desktop-launch-"));
  return {
    path,
    [Symbol.dispose]() {
      NodeFS.rmSync(path, { recursive: true, force: true });
    },
  };
}

it("copies the historical fixture into a temp home and keeps its workspace there", () => {
  using scratch = scratchDirectory();
  const original = NodeFS.readFileSync(DESKTOP_LAUNCH_FIXTURE);
  const { dbPath } = prepareDesktopLaunchHome(scratch.path);
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    assertSafeDesktopFixture(database);
    expect(
      database.prepare("SELECT workspace_root FROM projection_projects").get()?.workspace_root,
    ).toBe(NodePath.join(scratch.path, "workspace"));
    expect(NodeFS.readFileSync(DESKTOP_LAUNCH_FIXTURE)).toEqual(original);
  } finally {
    database.close();
  }
});

it.each([
  [
    "auth_sessions",
    `INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
     VALUES ('fixture-auth', 'fixture', '[]', 'pairing', '2026-10-27', '2099-01-01')`,
  ],
  [
    "provider_session_runtime",
    `INSERT INTO provider_session_runtime (thread_id, provider_name, adapter_key, status, last_seen_at)
     VALUES ('launch-check-thread', 'codex', 'codex', 'idle', '2026-10-27')`,
  ],
  [
    "orchestration_v2_projection_provider_sessions",
    `INSERT INTO orchestration_v2_projection_provider_sessions
     (provider_session_id, provider, status, updated_at, payload_json)
     VALUES ('fixture-session', 'codex', 'idle', '2026-10-27', '{}')`,
  ],
  [
    "scheduled_tasks",
    `INSERT INTO scheduled_tasks
     (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
      model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
      created_at, updated_at, last_run_status, run_count)
     VALUES ('fixture-task', 'Unsafe task', 'Do not run', 1, '{}', 'launch-check-project', '{}',
      '{}', 'full-access', 'default', 'user', 'server', '2026-10-27', '2026-10-27', 'never', 0)`,
  ],
  [
    "orchestration_v2_effect_outbox",
    `INSERT INTO orchestration_v2_effect_outbox
     (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
     VALUES ('fixture-effect', 'fixture-command', 'launch-check-thread', 'provider.turn.start', '{}',
      'pending', '2026-10-27', '2026-10-27', '2026-10-27')`,
  ],
])("rejects a fixture containing %s before app launch", (table, insert) => {
  using scratch = scratchDirectory();
  const { dbPath } = prepareDesktopLaunchHome(scratch.path);
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec(insert);
    expect(() => assertSafeDesktopFixture(database)).toThrow(`${table} must be empty`);
  } finally {
    database.close();
  }
});

it("rejects a fixture whose historical migration boundary changed", () => {
  using scratch = scratchDirectory();
  const { dbPath } = prepareDesktopLaunchHome(scratch.path);
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 69");
    expect(() => assertSafeDesktopFixture(database)).toThrow("must stop at migration 69");
  } finally {
    database.close();
  }
});

it("rejects a fixture missing the thread the release gate must open", () => {
  using scratch = scratchDirectory();
  const { dbPath } = prepareDesktopLaunchHome(scratch.path);
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec(
      "DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'launch-check-thread'",
    );
    expect(() => assertSafeDesktopFixture(database)).toThrow("missing its seeded thread history");
  } finally {
    database.close();
  }
});

it("rejects a launch that never migrated the historical database", () => {
  using scratch = scratchDirectory();
  const { dbPath } = prepareDesktopLaunchHome(scratch.path);
  expect(() => assertDesktopLaunchMigrated(dbPath)).toThrow("did not apply GOAT's migrations");
});
