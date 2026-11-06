import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

const space = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "135_MemoryGenerationDiagnosticsBacklog",
  (it) => {
    it.effect("generation diagnostics never count as reports waiting for delivery", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const report = (id: string, kind: string, state: string, target = space) =>
          sql`INSERT INTO memory_report_outbox
            (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
            VALUES (${id},${target},${id},${id},NULL,${id},'environment','failed',${state},'generation_failed',0,${kind},1,1)`;
        const counters = (target = space) =>
          sql<{
            dimension: string;
            value: number;
          }>`SELECT dimension,value FROM memory_quota_counters
            WHERE space=${target} AND scope_key='' AND dimension IN ('processing_report_backlog','processing_report_failed') ORDER BY dimension`.pipe(
            Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.dimension, row.value]))),
          );
        yield* runMigrations({ toMigrationInclusive: 134 });
        yield* report("summary", "summary", "pending");
        yield* report("consolidate", "consolidate", "failed");
        yield* report("resolve", "resolve", "failed");
        yield* report("only-diagnostic", "summary", "pending", other);
        assert.deepStrictEqual(yield* counters(), {
          processing_report_backlog: 3,
          processing_report_failed: 2,
        });

        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 135 }), [
          [135, "MemoryGenerationDiagnosticsBacklog"],
        ]);
        assert.deepStrictEqual(yield* counters(), {
          processing_report_backlog: 1,
          processing_report_failed: 1,
        });
        assert.deepStrictEqual(yield* counters(other), {
          processing_report_backlog: 0,
          processing_report_failed: 0,
        });

        yield* report("later", "consolidate", "pending");
        yield* sql`UPDATE memory_report_outbox SET state='failed' WHERE report_id='summary'`;
        assert.deepStrictEqual(yield* counters(), {
          processing_report_backlog: 1,
          processing_report_failed: 1,
        });
        yield* sql`UPDATE memory_report_outbox SET state='pending' WHERE report_id='resolve'`;
        yield* sql`UPDATE memory_report_outbox SET space=${other} WHERE report_id='resolve'`;
        assert.deepStrictEqual(yield* counters(), {
          processing_report_backlog: 0,
          processing_report_failed: 0,
        });
        assert.deepStrictEqual(yield* counters(other), {
          processing_report_backlog: 1,
          processing_report_failed: 0,
        });
        yield* sql`DELETE FROM memory_report_outbox`;
        assert.deepStrictEqual(yield* counters(other), {
          processing_report_backlog: 0,
          processing_report_failed: 0,
        });
      }),
    );
  },
);
