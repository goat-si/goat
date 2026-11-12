import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const NOW = "2026-11-12T00:00:00.000Z";

it.effect(
  "rows written before the upgrade read as posts, and edit and end rows find their target by index",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 140 });
      yield* sql`INSERT INTO channel_outbox ${sql.insert({
        delivery_id: "before",
        cause_key: "test:before",
        input_id: null,
        task_id: "task-1",
        kind: "receipt",
        destination_kind: "slack",
        message_json: "{}",
        state: "delivered",
        attempts: 1,
        next_attempt_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      })}`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 142 }), [
        [142, "ChannelOutboxOperations"],
      ]);
      const [row] = yield* sql<{
        readonly operation: string;
        readonly target_delivery_id: string | null;
      }>`SELECT operation, target_delivery_id FROM channel_outbox WHERE delivery_id = 'before'`;
      assert.deepStrictEqual(row, { operation: "post", target_delivery_id: null });
      const plan = (yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
        SELECT delivery_id FROM channel_outbox WHERE target_delivery_id = 'before'`).map(
        (step) => step.detail,
      );
      assert.isTrue(
        plan.some((detail) => detail.includes("USING INDEX channel_outbox_target_idx")),
        plan.join("\n"),
      );
      const refused = yield* sql`UPDATE channel_outbox SET operation = 'reply'
        WHERE delivery_id = 'before'`.pipe(Effect.result);
      assert.strictEqual(refused._tag, "Failure");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
