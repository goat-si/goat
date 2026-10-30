import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

for (const actor of ["client", "server"] as const) {
  it.effect(`backfills a past ${actor} approval from the event history`, () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 119 });
      const payload = JSON.stringify({
        type: "human_handoff",
        handoff: {
          target: { path: "computer_use.grant" },
          state: "completed",
          actor: { type: actor },
        },
      });
      yield* sql`INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
        VALUES ('approval', 'thread', 'thread', 1, 'turn-item.updated', '2026-10-30', 'server', ${payload}, '{}', 2)`;
      yield* runMigrations({ toMigrationInclusive: 120 });
      assert.equal(
        (yield* sql`SELECT id FROM computer_use_person_approval`).length,
        actor === "client" ? 1 : 0,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
}
