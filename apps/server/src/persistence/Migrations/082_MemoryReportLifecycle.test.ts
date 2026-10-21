import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import reportMigration from "./082_MemoryReportLifecycle.ts";
const database = NodeSqliteClient.layer({ filename: ":memory:" });
it.effect("077 DDL and accounting rollback together then ledger restart preserves rows", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 81 });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolving_environment_id,outcome,state,created_at) VALUES ('legacy','space','memory','op','owner','failed','pending',0)`;
    const before =
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
    yield* sql
      .withTransaction(reportMigration.pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.exit);
    assert.isFalse(
      (yield* sql<{ name: string }>`PRAGMA table_info(memory_report_outbox)`).some(
        (r) => r.name === "automatic_attempts",
      ),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
      before,
    );
    assert.deepStrictEqual(yield* runMigrations(), [
      [82, "MemoryReportLifecycle"],
      [83, "MemoryUsageCounters"],
      [84, "MemoryRevertResults"],
      [85, "HandoffLookupIndex"],
      [86, "MemoryLastReadySpace"],
      [87, "MemoryHubAdministered"],
      [88, "MemoryCheckpointLifecycle"],
      [89, "FleetGoals"],
      [90, "FleetHealth"],
      [91, "ThreadRunObservedChecks"],
      [92, "RemoteDispatchObservation"],
      [93, "MemoryRevisionCheckpointSize"],
      [94, "HubNodes"],
      [95, "PermissionProfiles"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT automatic_attempts,report_kind,report_approved FROM memory_report_outbox`,
      [{ automatic_attempts: 0, report_kind: "unknown", report_approved: 0 }],
    );
    const migrated =
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
      migrated,
    );
    assert.strictEqual(
      (yield* sql`UPDATE memory_report_outbox SET automatic_attempts=11`.pipe(Effect.exit))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(database)),
);
it.effect("077 refuses an incompatible prerelease ledger before modifying memory", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE effect_sql_migrations SET migration_id=177 WHERE name='MemoryReportLifecycle'`;
    assert.strictEqual((yield* runMigrations().pipe(Effect.exit))._tag, "Failure");
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM effect_sql_migrations WHERE name='MemoryReportLifecycle' AND migration_id=177`)
        .length,
      1,
    );
  }).pipe(Effect.provide(database)),
);

const encodeCompact = Schema.encodeEffect(Schema.fromJsonString(M.MemoryCompactReceipt));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubReceipt));
it.effect("077 classifies only matching durable guards and leaves legacy attempts unknown", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 81 });
    const sql = yield* SqlClient.SqlClient;
    const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
    const memory = M.MemoryId.make("00000000-0000-4000-8000-000000000002");
    const operationId = M.MemoryOperationId.make("00000000-0000-4000-8000-000000000003");
    const resolutionId = M.MemoryResolutionId.make("00000000-0000-4000-8000-000000000004");
    const proven = "a".repeat(64);
    const ambiguous = "b".repeat(64);
    const record = M.MemoryCompactReceipt.make({
      memorySpaceId: space,
      originEnvironmentId: M.EnvironmentId.make("A"),
      operationKind: "resolve",
      receipt: {
        operationId,
        memoryId: memory,
        operationDigest: "c".repeat(64),
        outcome: "accepted",
        hubSequence: 1,
        resolutionApproval: {
          resolutionId,
          appliedAtUtc: M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z"),
          revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-11-14T00:00:00.000Z"),
        },
      },
      revisionId: M.MemoryRevisionId.make("00000000-0000-4000-8000-000000000005"),
      resolutionId,
      revertsResolutionId: null,
      attemptId: operationId,
      fencingToken: 1,
      reportGuard: {
        reportId: proven,
        resolvingEnvironmentId: M.EnvironmentId.make("A"),
        resolutionId,
        outcome: "resolved",
      },
    });
    const compact = yield* encodeCompact(record);
    const receipt = yield* encodeReceipt(record.receipt);
    yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES (${space},${operationId},${record.receipt.operationDigest},1,${receipt},${compact})`;
    for (const rid of [proven, ambiguous])
      yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at) VALUES (${rid},${space},${memory},${operationId},${resolutionId},'A','resolved','pending',0)`;
    const contradictions = [
      ["c", "$.originEnvironmentId", "B"],
      ["d", "$.receipt.operationId", "00000000-0000-4000-8000-000000000099"],
      ["e", "$.resolutionId", "00000000-0000-4000-8000-000000000098"],
    ] as const;
    for (const [n, [key, path, value]] of contradictions.entries()) {
      const op = M.MemoryOperationId.make(
        `00000000-0000-4000-8000-${String(20 + n).padStart(12, "0")}`,
      );
      const rid = key.repeat(64);
      const canonical = {
        ...record,
        receipt: { ...record.receipt, operationId: op },
        reportGuard: { ...record.reportGuard!, reportId: rid },
      };
      yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES (${space},${op},${record.receipt.operationDigest},1,${yield* encodeReceipt(canonical.receipt)},json_set(${yield* encodeCompact(canonical)},${path},${value}))`;
      yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at) VALUES (${rid},${space},${memory},${op},${resolutionId},'A','resolved','pending',0)`;
    }
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT report_kind,report_approved FROM memory_report_outbox WHERE report_id IN (${"c".repeat(64)},${"d".repeat(64)},${"e".repeat(64)})`,
      Array.from({ length: 3 }, () => ({ report_kind: "unknown", report_approved: 0 })),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT report_id,report_kind,report_approved,automatic_attempts,attempts_known FROM memory_report_outbox WHERE report_id IN (${proven},${ambiguous}) ORDER BY report_id`,
      [
        {
          report_id: proven,
          report_kind: "resolve",
          report_approved: 1,
          automatic_attempts: 0,
          attempts_known: 0,
        },
        {
          report_id: ambiguous,
          report_kind: "unknown",
          report_approved: 0,
          automatic_attempts: 0,
          attempts_known: 0,
        },
      ],
    );
  }).pipe(Effect.provide(database)),
);
