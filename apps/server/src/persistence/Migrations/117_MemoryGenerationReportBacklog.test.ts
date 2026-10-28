import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

const space = "00000000-0000-4000-8000-000000000001";
const report = (
  reportId: string,
  memoryId: string,
  createdAt: number,
  kind = "consolidate",
  outcome = "failed",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_report_outbox
      (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
      VALUES (${reportId},${space},${memoryId},${reportId},NULL,${reportId},'environment',${outcome},'pending',${outcome === "failed" ? "generation_failed" : null},${createdAt},${kind},1,1)`;
  });

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "117_MemoryGenerationReportBacklog",
  (it) => {
    it.effect(
      "keeps the newest generation diagnostic per memory, at most 100, and frees their capacity",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 116 });
          // One memory failed on every retry; 150 others failed once; one real delivery is queued.
          for (let attempt = 0; attempt < 5; attempt++)
            yield* report(`retry-${attempt}`, "retried", 1000 + attempt);
          for (let index = 0; index < 150; index++)
            yield* report(`once-${index}`, `memory-${index}`, index);
          yield* report("resolution", "resolved", 0, "resolve", "resolved");
          const counted = () =>
            sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='report_items' AND scope_key=''`;
          assert.strictEqual((yield* counted())[0]?.value, 156);
          assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 117 }), [
            [117, "MemoryGenerationReportBacklog"],
          ]);
          const kept = yield* sql<{
            report_id: string;
          }>`SELECT report_id FROM memory_report_outbox ORDER BY created_at DESC,report_id DESC`;
          assert.strictEqual(kept.length, 101);
          assert.strictEqual(kept[0]?.report_id, "retry-4");
          assert.isFalse(kept.some((row) => row.report_id === "retry-3"));
          assert.isTrue(kept.some((row) => row.report_id === "resolution"));
          assert.isFalse(kept.some((row) => row.report_id === "once-50"));
          assert.strictEqual((yield* counted())[0]?.value, 101);
        }),
    );
  },
);
