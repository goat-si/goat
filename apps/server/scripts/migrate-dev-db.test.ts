// @effect-diagnostics nodeBuiltinImport:off - runs the CLI in a child process and checks real modes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E>(
  databasePath: string,
  effect: Effect.Effect<A, E, SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO memory_items_fts (rowid, body) VALUES (42, 'synthetic searchable memory')`;

      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', '[]', '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      const threads = [
        ["stopped-thread", "project-kept", "completed", "{}", "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "archived-thread",
          "project-kept",
          "completed",
          '{"archivedAt":"2026-08-01"}',
          "2026-08-05",
        ],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}')`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'archived-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
      for (const threadId of ["stopped-thread", "running-thread", "settled-thread"] as const) {
        const correlationId = `corr-${threadId}`;
        yield* sql`INSERT INTO remote_report_bindings
          (thread_id, correlation_id, origin_label, origin_thread_id, read_key_hash, last_sequence, created_at)
          VALUES (${threadId}, ${correlationId}, 'origin', ${`origin-${threadId}`}, 'hash', 1, '2026-08-01')`;
        yield* sql`INSERT INTO remote_reports
          (correlation_id, sequence, run_id, kind, summary, created_at)
          VALUES (${correlationId}, 1, ${`run-${threadId}`}, 'completed', 'done', '2026-08-01')`;
      }
      // A generated column on a row with no thread. SELECT * cannot copy this
      // table; the flag must be recomputed, and the row must not mark a family live.
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, provider, status, updated_at, payload_json)
        VALUES (
          'roster-active',
          'codex',
          'idle',
          '2026-08-01',
          '{"pendingBackgroundTasks":[{"taskId":"background"}]}'
        )`;
    }),
  );
  return databasePath;
});

const isWindows = HostProcess.Platform.defaultValue() === "win32";
const permissions = (file: string) => NodeFS.statSync(file).mode & 0o777;

// The umask is set inside the child, so these runs never depend on the host's umask.
const runCliUnderUmask002 = (home: string, args: ReadonlyArray<string>) =>
  Effect.sync(() =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import=data:text/javascript,process.umask(0o002)",
        NodePath.join(import.meta.dirname, "migrate-dev-db.ts"),
        "--projects",
        "1",
        "--threads-per-project",
        "1",
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
    ),
  );

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect(
    "refuses a base dir inside a live userdata tree, also through a symlink, and still accepts its dev home (#1648)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-live-" });
        const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-link-" });
        const source = yield* createFixtureSource(home);
        const liveState = path.dirname(source);
        yield* fs.symlink(liveState, path.join(elsewhere, "link"));
        yield* fs.makeDirectory(path.join(liveState, "existing"));
        yield* fs.symlink(path.join(liveState, "existing"), path.join(elsewhere, "into-live"));
        const liveBefore = yield* fs.readDirectory(liveState);

        for (const baseDir of [
          liveState,
          path.join(liveState, "nested"),
          path.join(elsewhere, "link", "nested"),
          path.join(elsewhere, "into-live", "nested"),
        ]) {
          const error = yield* runMigrateDevDb(
            { baseDir, source, projects: 1, threadsPerProject: 1 },
            { sourceHomes: [home] },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "MigrateDevDbSharedHomeError", baseDir);
        }
        // A filesystem that reports no inode still sees through the link.
        const withoutInodes = yield* runMigrateDevDb(
          {
            baseDir: path.join(elsewhere, "link", "nested"),
            source,
            projects: 1,
            threadsPerProject: 1,
          },
          { sourceHomes: [home] },
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (target) =>
              fs.stat(target).pipe(Effect.map((info) => ({ ...info, ino: Option.none() }))),
          }),
          Effect.flip,
        );
        assert.equal(withoutInodes._tag, "MigrateDevDbSharedHomeError");
        assert.deepEqual(yield* fs.readDirectory(liveState), liveBefore);
        assert.deepEqual(yield* fs.readDirectory(path.join(liveState, "existing")), []);

        // A home or userdata that does not exist yet is still protected.
        const absentHome = path.join(elsewhere, "absent-home");
        for (const baseDir of [absentHome, path.join(absentHome, "userdata", "nested")]) {
          const error = yield* runMigrateDevDb(
            { baseDir, source, projects: 1, threadsPerProject: 1 },
            { sourceHomes: [absentHome] },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "MigrateDevDbSharedHomeError", baseDir);
        }
        assert.isFalse(yield* fs.exists(absentHome));

        // A live userdata that is itself a link, and a differently cased name
        // where the filesystem ignores case, are the same directory.
        const linkedHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-linked-" });
        const realState = path.join(elsewhere, "real-userdata");
        yield* fs.makeDirectory(realState);
        yield* fs.symlink(realState, path.join(linkedHome, "userdata"));
        const caseVariant = path.join(home, "USERDATA");
        for (const baseDir of [
          path.join(realState, "nested"),
          ...((yield* fs.exists(caseVariant)) ? [path.join(caseVariant, "nested")] : []),
        ]) {
          const error = yield* runMigrateDevDb(
            { baseDir, source, projects: 1, threadsPerProject: 1 },
            { sourceHomes: [home, linkedHome] },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "MigrateDevDbSharedHomeError", baseDir);
        }
        assert.deepEqual(yield* fs.readDirectory(realState), []);

        yield* runMigrateDevDb(
          { baseDir: path.join(home, "dev"), source, projects: 1, threadsPerProject: 1 },
          { sourceHomes: [home] },
        );
      }),
  );

  it.effect.each(["running", "completed"] as const)(
    "seeds a family only after its remote task is finished (%s)",
    (status) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-remote-" });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-remote-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        yield* withDatabase(
          source,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO orchestration_v2_projection_subagents
          (subagent_id, thread_id, run_id, parent_node_id, provider, origin, status, updated_at, payload_json)
          VALUES ('remote-task', 'fork-thread', 'run-fork-thread', 'parent-node', 'codex', 'app_owned',
            ${status}, '2026-08-01', '{"remote":{"host":"fixture-host","threadId":"remote-child","correlationId":"fixture"}}')`;
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('remote-item', 'fork-thread', 'run-fork-thread', 1, 'subagent', 'running', '2026-08-01', '{}')`;
          }),
        );
        const result = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
          { sharedHome: sourceDir },
        );
        const threads = yield* withDatabase(
          result.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              thread_id: string;
            }>`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          }),
        );
        assert.deepEqual(
          threads.map((row) => row.thread_id),
          status === "running"
            ? ["settled-thread"]
            : ["fork-thread", "settled-thread", "stopped-thread"],
        );
      }),
  );

  it.effect.each([false, true])(
    "pending request=%s controls retention of a stopped family",
    (pending) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-pending-" });
        const destDir = yield* fs.makeTempDirectoryScoped({
          prefix: "migrate-dev-db-pending-dest-",
        });
        const source = yield* createFixtureSource(sourceDir);
        if (pending)
          yield* withDatabase(
            source,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
          (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
          VALUES ('pending-request', 'fork-thread', 'node-1', 'user_input', 'pending', '2026-08-01', '{}')`;
            }),
          );
        const result = yield* runMigrateDevDb(
          { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
          { sharedHome: sourceDir },
        );
        const threads = yield* withDatabase(
          result.databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              thread_id: string;
            }>`SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          }),
        );
        assert.deepEqual(
          threads.map((row) => row.thread_id),
          pending ? ["settled-thread"] : ["fork-thread", "settled-thread", "stopped-thread"],
        );
      }),
  );

  it.effect("retains a stopped family with stale terminal items and its history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-stale-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-stale-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const threadId of ["stopped-thread", "fork-thread", "running-thread"] as const) {
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
            VALUES (${`item-${threadId}`}, ${threadId}, ${`run-${threadId}`}, 1,
              'command_execution', 'running', '2026-08-01', '{}')`;
          }
        }),
      );
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );
      yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          assert.deepEqual(
            threads.map((row) => row.thread_id),
            ["fork-thread", "settled-thread", "stopped-thread"],
          );
          const items = yield* sql<{ turn_item_id: string }>`
          SELECT turn_item_id FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id`;
          assert.deepEqual(
            items.map((row) => row.turn_item_id),
            ["item-fork-thread", "item-stopped-thread"],
          );
          const events = yield* sql<{ stream_id: string }>`
          SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          assert.deepEqual(
            events.map((row) => row.stream_id),
            ["fork-thread", "settled-thread", "stopped-thread"],
          );
          assert.deepEqual(
            yield* sql`SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests`,
            [],
          );
        }),
      );
    }),
  );

  it.effect("keeps stopped and settled thread families and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT rowid, body FROM memory_items_fts WHERE memory_items_fts MATCH 'searchable'`,
            [{ rowid: 42, body: "synthetic searchable memory" }],
          );
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const reports = yield* sql<{ correlation_id: string }>`
            SELECT correlation_id FROM remote_reports ORDER BY correlation_id`;
          const [leftovers] = yield* sql<{ auth: number; tasks: number; transfers: number }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers`;
          const [roster] = yield* sql<{ has_pending_background_work: number }>`
            SELECT has_pending_background_work
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = 'roster-active'`;
          yield* sql`UPDATE orchestration_v2_projection_provider_threads
            SET payload_json = '{}' WHERE provider_thread_id = 'roster-active'`;
          const [cleared] = yield* sql<{ has_pending_background_work: number }>`
            SELECT has_pending_background_work
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = 'roster-active'`;
          return {
            threads,
            events,
            sessions,
            reports,
            leftovers,
            pending: roster?.has_pending_background_work,
            cleared: cleared?.has_pending_background_work,
          };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(
        kept.reports.map((row) => row.correlation_id),
        ["corr-settled-thread", "corr-stopped-thread"],
      );
      assert.deepStrictEqual(kept.leftovers, { auth: 0, tasks: 0, transfers: 0 });
      assert.equal(kept.pending, 1);
      assert.equal(kept.cleared, 0);
    }),
  );

  it.effect("never copies an archived thread, and new events append after the source's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const [sourceSequence] = yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [archivedRows] = yield* sql<{ count: number }>`
            SELECT
              (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = 'archived-thread')
              + (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'archived-thread')
              AS count`;
          const [sequence] = yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          return { archivedRows: archivedRows?.count, sequence: sequence?.seq };
        }),
      );
      assert.equal(copied.archivedRows, 0);
      assert.equal(copied.sequence, sourceSequence?.seq);
    }),
  );

  it.effect("skips a thread family larger than the per-project limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      // stopped-thread and its fork are 2 threads; settled-thread is 1.
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["settled-thread"],
      );
    }),
  );

  it.effect("upgrades a source from before the V2 thread tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(source, runMigrations({ toMigrationInclusive: 54 }));

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.include(result.executedMigrations, "55_OrchestrationV2");
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      const leftoverSnapshot = path.join(destDir, "userdata", "statev2.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("reads ~/.goat first and falls back to ~/.t3", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const goatDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-goat-" });
      const legacyDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-t3-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-home-dest-" });
      const goatSource = yield* createFixtureSource(goatDir);
      const t3Source = yield* createFixtureSource(legacyDir);
      yield* withDatabase(
        goatSource,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_projects SET title = 'From Goat' WHERE project_id = 'project-kept'`;
        }),
      );
      yield* withDatabase(
        t3Source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE projection_projects SET title = 'From T3' WHERE project_id = 'project-kept'`;
        }),
      );

      const fromGoat = yield* runMigrateDevDb(
        { baseDir: destDir, projects: 1, threadsPerProject: 1 },
        { sourceHomes: [goatDir, legacyDir] },
      );
      assert.equal(fromGoat.projects[0]?.title, "From Goat");

      yield* fs.remove(goatSource);
      const fallbackDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-home-fallback-",
      });
      const fromT3 = yield* runMigrateDevDb(
        { baseDir: fallbackDir, projects: 1, threadsPerProject: 1 },
        { sourceHomes: [goatDir, legacyDir] },
      );
      assert.equal(fromT3.projects[0]?.title, "From T3");

      const missingGoat = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-no-goat-" });
      const missingT3 = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-no-t3-" });
      const missing = yield* runMigrateDevDb(
        { baseDir: destDir, projects: 1, threadsPerProject: 1 },
        { sourceHomes: [missingGoat, missingT3] },
      ).pipe(Effect.flip);
      assert.equal(missing._tag, "MigrateDevDbSourceMissingError");
      if (missing._tag === "MigrateDevDbSourceMissingError") {
        assert.equal(missing.sourcePath, path.join(missingGoat, "userdata", "statev2.sqlite"));
      }
    }),
  );

  it.effect("refuses to rebuild a source home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const goatDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-protect-goat-" });
      const legacyDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-protect-t3-" });
      const source = yield* createFixtureSource(legacyDir);

      const error = yield* runMigrateDevDb(
        { baseDir: goatDir, source, projects: 1, threadsPerProject: 1 },
        { sourceHomes: [goatDir, legacyDir] },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );

  it.effect("drops foreign keys to threads the filter removed and leaves none dangling", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-fk-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-fk-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // Child has no thread_id. Its parent snippet is dropped with the settled thread.
          yield* sql`CREATE TABLE dev_snapshot_snippets (
            snippet_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL
          )`;
          yield* sql`CREATE TABLE dev_snapshot_snippet_refs (
            ref_id TEXT PRIMARY KEY,
            snippet_id TEXT NOT NULL REFERENCES dev_snapshot_snippets(snippet_id)
          )`;
          yield* sql`INSERT INTO dev_snapshot_snippets (snippet_id, thread_id) VALUES
            ('kept-snip', 'stopped-thread'),
            ('dropped-snip', 'archived-thread')`;
          yield* sql`INSERT INTO dev_snapshot_snippet_refs (ref_id, snippet_id) VALUES
            ('kept-ref', 'kept-snip'),
            ('dropped-ref', 'dropped-snip')`;
          // Self-reference: a kept thread's step points at an archived thread's step,
          // and the following step points at that. The insert predicate skips
          // self-references, so enforcement during the copy used to fail here.
          yield* sql`CREATE TABLE dev_snapshot_steps (
            step_id TEXT PRIMARY KEY,
            prev_step_id TEXT REFERENCES dev_snapshot_steps(step_id),
            thread_id TEXT NOT NULL
          )`;
          yield* sql`INSERT INTO dev_snapshot_steps (step_id, prev_step_id, thread_id) VALUES
            ('kept-step', NULL, 'stopped-thread'),
            ('mid-step', 'kept-step', 'stopped-thread'),
            ('dropped-step', NULL, 'archived-thread'),
            ('link-step', 'dropped-step', 'stopped-thread'),
            ('tail-step', 'link-step', 'stopped-thread')`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const violations = yield* sql.unsafe<{ table: string }>("PRAGMA foreign_key_check")
            .unprepared;
          const snippets = yield* sql<{ snippet_id: string }>`
            SELECT snippet_id FROM dev_snapshot_snippets ORDER BY snippet_id`;
          const refs = yield* sql<{ ref_id: string }>`
            SELECT ref_id FROM dev_snapshot_snippet_refs ORDER BY ref_id`;
          const steps = yield* sql<{ step_id: string }>`
            SELECT step_id FROM dev_snapshot_steps ORDER BY step_id`;
          return { violations, snippets, refs, steps };
        }),
      );
      assert.deepStrictEqual(copied.violations, []);
      assert.deepStrictEqual(
        copied.snippets.map((row) => row.snippet_id),
        ["kept-snip"],
      );
      assert.deepStrictEqual(
        copied.refs.map((row) => row.ref_id),
        ["kept-ref"],
      );
      assert.deepStrictEqual(
        copied.steps.map((row) => row.step_id),
        ["kept-step", "mid-step"],
      );
    }),
  );

  it.effect("keeps the newest stopped threads of each project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-per-project-",
      });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-per-project-dest-",
      });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const projectId of ["proj-a", "proj-b", "proj-c"] as const) {
            yield* sql`INSERT INTO projection_projects
              (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
              VALUES (
                ${projectId}, ${projectId}, ${`/tmp/${projectId}`}, '[]',
                '2026-09-01', '2026-09-04', NULL
              )`;
            for (const [suffix, updatedAt] of [
              ["old", "2026-09-01"],
              ["mid", "2026-09-02"],
              ["new", "2026-09-03"],
              ["newest", "2026-09-04"],
            ] as const) {
              const threadId = `${projectId}-${suffix}`;
              yield* sql`INSERT INTO orchestration_v2_projection_threads
                (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
                VALUES (
                  ${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default',
                  '2026-09-01', ${updatedAt}, '{}'
                )`;
              yield* sql`INSERT INTO orchestration_v2_projection_runs
                (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
                VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', 'completed', '2026-09-01', '{}')`;
            }
          }
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 3, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE project_id IN ('proj-a', 'proj-b', 'proj-c')
            ORDER BY thread_id`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        [
          "proj-a-new",
          "proj-a-newest",
          "proj-b-new",
          "proj-b-newest",
          "proj-c-new",
          "proj-c-newest",
        ],
      );
    }),
  );

  it.effect("keeps ordinary failed threads and drops usage-limit failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-failed-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-failed-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
            VALUES (
              'project-failed', 'Failed Project', '/tmp/failed', '[]',
              '2026-10-01', '2026-10-05', NULL
            )`;
          const threads = [
            ["failed-old", "2026-10-02", false],
            ["failed-mid", "2026-10-03", false],
            ["failed-new", "2026-10-04", false],
            ["failed-limit", "2026-10-05", true],
          ] as const;
          for (const [threadId, updatedAt, usageLimit] of threads) {
            yield* sql`INSERT INTO orchestration_v2_projection_threads
              (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
              VALUES (
                ${threadId}, 'project-failed', ${threadId}, 'codex', 'full-access', 'default',
                '2026-10-01', ${updatedAt}, '{}'
              )`;
            yield* sql`INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
              VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', 'failed', '2026-10-01', '{}')`;
            if (usageLimit) {
              yield* sql`INSERT INTO orchestration_v2_projection_turn_items
                (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
                VALUES (
                  ${`item-${threadId}`}, ${threadId}, ${`run-${threadId}`}, 0,
                  'error', 'failed', ${updatedAt}, '{"failure":{"class":"usage_limit"}}'
                )`;
            }
          }
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 1, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.projects[0]?.title, "Failed Project");
      assert.equal(result.projects[0]?.threads, 2);
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["failed-mid", "failed-new"],
      );
    }),
  );
});

// Child processes, so these run live, outside the shared layer.
it.live.skipIf(isWindows)(
  "creates a missing worktree home and userdata private under umask 002 and leaves the source alone (#1648)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-umask-" });
      const source = yield* createFixtureSource(NodePath.join(root, "source"));
      const sourceBefore = { bytes: NodeFS.readFileSync(source), mode: permissions(source) };
      const baseDir = NodePath.join(root, "worktree", ".goat");

      const child = yield* runCliUnderUmask002(root, ["--base-dir", baseDir, "--source", source]);

      assert.equal(child.status, 0, child.stderr);
      assert.equal(permissions(baseDir), 0o700);
      assert.equal(permissions(NodePath.join(baseDir, "userdata")), 0o700);
      assert.deepEqual(NodeFS.readFileSync(source), sourceBefore.bytes);
      assert.equal(permissions(source), sourceBefore.mode);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(isWindows)(
  "removes group and other write from an existing userdata and says so (#1648)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-writable-" });
      const source = yield* createFixtureSource(NodePath.join(root, "source"));
      const baseDir = NodePath.join(root, "worktree", ".goat");
      const stateDir = NodePath.join(baseDir, "userdata");
      NodeFS.mkdirSync(stateDir, { recursive: true });
      NodeFS.chmodSync(baseDir, 0o775);
      NodeFS.chmodSync(stateDir, 0o775);

      const child = yield* runCliUnderUmask002(root, ["--base-dir", baseDir, "--source", source]);

      assert.equal(child.status, 0, child.stderr);
      assert.equal(permissions(stateDir), 0o755);
      assert.include(child.stdout, `Removed group and other write permission from ${stateDir}`);
      // Only the userdata it rebuilds: --base-dir may be any directory.
      assert.equal(permissions(baseDir), 0o775);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(isWindows)(
  "refuses a symlinked userdata before touching the database it points at (#1648)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-symlink-" });
      const source = yield* createFixtureSource(NodePath.join(root, "source"));
      const target = yield* createFixtureSource(NodePath.join(root, "elsewhere"));
      const targetBefore = NodeFS.readFileSync(target);
      const baseDir = NodePath.join(root, "worktree", ".goat");
      NodeFS.mkdirSync(baseDir, { recursive: true });
      NodeFS.symlinkSync(NodePath.dirname(target), NodePath.join(baseDir, "userdata"));

      const child = yield* runCliUnderUmask002(root, ["--base-dir", baseDir, "--source", source]);

      assert.notEqual(child.status, 0);
      assert.include(child.stdout + child.stderr, "is a symlink");
      assert.deepEqual(NodeFS.readFileSync(target), targetBefore);
    }).pipe(Effect.provide(NodeServices.layer)),
);
