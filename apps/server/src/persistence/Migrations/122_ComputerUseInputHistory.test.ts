import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("122_ComputerUseInputHistory", (it) => {
  it.effect("upgrades after approvals, stores an input and preserves prior migration records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 121 });
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 122 }), [
        [122, "ComputerUseInputHistory"],
      ]);
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(computer_use_input_history)`;
      assert.isTrue(columns.some((column) => column.name === "order_seq"));
      yield* sql`INSERT INTO computer_use_input_history
        (thread_id, recorded_at, target_kind, method, verdict)
        VALUES ('thread:a', 42, 'tab', 'click', 'sent')`;
      assert.deepStrictEqual(yield* sql`SELECT thread_id, method FROM computer_use_input_history`, [
        { thread_id: "thread:a", method: "click" },
      ]);
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 122 }), []);
    }),
  );
});
