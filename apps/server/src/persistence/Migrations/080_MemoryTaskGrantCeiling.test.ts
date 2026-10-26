import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationEntries, runMigrations } from "../Migrations.ts";
import { reconcileGoatMigrationIds } from "../reconcileGoatMigrationIds.ts";

const insertTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      INSERT INTO scheduled_tasks (
        task_id,title,prompt,enabled,schedule_json,project_id,workspace_strategy_json,
        model_selection_json,runtime_mode,interaction_mode,created_by,creation_source,
        created_at,updated_at,last_run_status,run_count
      ) VALUES (
        'synthetic-task','Synthetic task','Synthetic prompt',1,'{}','synthetic-project','{}',
        '{}','full-access','default','agent','mcp','2026-10-15','2026-10-15','never',0
      )
    `;
});

const insertDispatches = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const kind of ["thread", "task"]) {
    yield* sql`
      INSERT INTO remote_dispatches (
        correlation_id,kind,origin_thread_id,host,read_key,delivery,state,created_at,updated_at
      ) VALUES (
        ${`synthetic-${kind}`},${kind},'synthetic-origin','synthetic-host','synthetic-read-key',
        'notify_only','launching','2026-10-15','2026-10-15'
      )
    `;
  }
});

it.effect(
  "defaults existing tasks and dispatches to none, constrains ceilings, and safely reruns via the ledger",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* insertTask;
      yield* insertDispatches;
      assert.deepStrictEqual(yield* runMigrations(), [
        [80, "MemoryTaskGrantCeiling"],
        [81, "MemoryImportLineage"],
        [82, "MemoryCheckpointAccounting"],
        [83, "MemoryReportLifecycle"],
        [84, "MemoryUsageCounters"],
        [85, "MemoryRevertResults"],
        [86, "HandoffLookupIndex"],
        [87, "MemoryLastReadySpace"],
        [88, "MemoryHubAdministered"],
        [89, "MemoryCheckpointLifecycle"],
        [90, "FleetGoals"],
        [91, "FleetHealth"],
        [92, "ThreadRunObservedChecks"],
        [93, "RemoteDispatchObservation"],
        [94, "MemoryRevisionCheckpointSize"],
        [95, "HubNodes"],
        [96, "MemorySummaryWorkThreadIndex"],
        [97, "ThreadHistoryArchives"],
        [98, "PermissionProfiles"],
        [99, "DecisionInbox"],
        [100, "HumanStepRecords"],
        [101, "McpRequestReservations"],
        [102, "RemoteReportInboxRunId"],
        [103, "RemoteReportReceipts"],
        [104, "PendingAttachmentUploads"],
        [105, "ScheduledTaskWebhookSecretRef"],
        [106, "RemoteReportFences"],
        [107, "HubProvisionedLinks"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
        { memory_grant_ceiling: "none" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT kind,memory_grant_ceiling FROM remote_dispatches ORDER BY kind`,
        [
          { kind: "task", memory_grant_ceiling: "none" },
          { kind: "thread", memory_grant_ceiling: "none" },
        ],
      );
      for (const ceiling of ["none", "read", "read_write"]) {
        yield* sql`UPDATE scheduled_tasks SET memory_grant_ceiling=${ceiling}`;
        yield* sql`UPDATE remote_dispatches SET memory_grant_ceiling=${ceiling}`;
        assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
          { memory_grant_ceiling: ceiling },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT kind,memory_grant_ceiling FROM remote_dispatches ORDER BY kind`,
          [
            { kind: "task", memory_grant_ceiling: ceiling },
            { kind: "thread", memory_grant_ceiling: ceiling },
          ],
        );
      }
      for (const ceiling of ["full-access", "", null]) {
        yield* sql`UPDATE scheduled_tasks SET memory_grant_ceiling=${ceiling}`.pipe(Effect.flip);
        yield* sql`UPDATE remote_dispatches SET memory_grant_ceiling=${ceiling}`.pipe(Effect.flip);
        assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
          { memory_grant_ceiling: "read_write" },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT kind,memory_grant_ceiling FROM remote_dispatches ORDER BY kind`,
          [
            { kind: "task", memory_grant_ceiling: "read_write" },
            { kind: "thread", memory_grant_ceiling: "read_write" },
          ],
        );
      }
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
        { memory_grant_ceiling: "read_write" },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT kind,memory_grant_ceiling FROM remote_dispatches ORDER BY kind`,
        [
          { kind: "task", memory_grant_ceiling: "read_write" },
          { kind: "thread", memory_grant_ceiling: "read_write" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects an unreleased ceiling ledger without changing grants or its evidence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* insertTask;
    yield* insertDispatches;
    yield* sql`UPDATE scheduled_tasks SET memory_grant_ceiling='read'`;
    yield* sql`UPDATE remote_dispatches SET memory_grant_ceiling='read'`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE name='MemorySearchCounters'`;
    yield* sql`UPDATE effect_sql_migrations SET migration_id=79 WHERE name='MemoryTaskGrantCeiling'`;
    const before =
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
    const result = yield* Effect.flip(reconcileGoatMigrationIds(migrationEntries));
    if (result._tag !== "MigrationError") return yield* result;
    assert.strictEqual(result.kind, "BadState");
    assert.include(result.message, "Unreleased memory DB is incompatible");
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
    assert.deepStrictEqual(yield* sql`SELECT memory_grant_ceiling FROM scheduled_tasks`, [
      { memory_grant_ceiling: "read" },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT kind,memory_grant_ceiling FROM remote_dispatches ORDER BY kind`,
      [
        { kind: "task", memory_grant_ceiling: "read" },
        { kind: "thread", memory_grant_ceiling: "read" },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
