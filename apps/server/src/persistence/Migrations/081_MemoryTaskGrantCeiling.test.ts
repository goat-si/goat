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
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* insertTask;
      yield* insertDispatches;
      assert.deepStrictEqual(yield* runMigrations(), [
        [81, "MemoryTaskGrantCeiling"],
        [82, "MemoryImportLineage"],
        [83, "MemoryCheckpointAccounting"],
        [84, "MemoryReportLifecycle"],
        [85, "MemoryUsageCounters"],
        [86, "MemoryRevertResults"],
        [87, "HandoffLookupIndex"],
        [88, "MemoryLastReadySpace"],
        [89, "MemoryHubAdministered"],
        [90, "MemoryCheckpointLifecycle"],
        [91, "FleetGoals"],
        [92, "FleetHealth"],
        [93, "ThreadRunObservedChecks"],
        [94, "RemoteDispatchObservation"],
        [95, "MemoryRevisionCheckpointSize"],
        [96, "HubNodes"],
        [97, "MemorySummaryWorkThreadIndex"],
        [98, "ThreadHistoryArchives"],
        [99, "PermissionProfiles"],
        [100, "DecisionInbox"],
        [101, "HumanStepRecords"],
        [102, "McpRequestReservations"],
        [103, "RemoteReportInboxRunId"],
        [104, "RemoteReportReceipts"],
        [105, "PendingAttachmentUploads"],
        [106, "ScheduledTaskWebhookSecretRef"],
        [107, "RemoteReportFences"],
        [108, "HubProvisionedLinks"],
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
    yield* sql`UPDATE effect_sql_migrations SET migration_id=80 WHERE name='MemoryTaskGrantCeiling'`;
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
