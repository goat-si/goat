import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("session approvals retain their event cutoff and legacy inserts fail closed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 120 });
    yield* sql`INSERT INTO computer_use_session_approvals (thread_id, app_key) VALUES ('t', 'legacy')`;
    yield* sql`INSERT INTO computer_use_session_approvals (thread_id, app_key, created_sequence, consent_sequence) VALUES ('t', 'new', 42, 17)`;
    const rows = yield* sql<{
      app_key: string;
      created_sequence: number;
      consent_sequence: number;
    }>`SELECT app_key, created_sequence, consent_sequence FROM computer_use_session_approvals ORDER BY app_key`;
    assert.deepEqual(
      rows.map((row) => [row.app_key, row.created_sequence, row.consent_sequence]),
      [
        ["legacy", 0, 0],
        ["new", 42, 17],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
