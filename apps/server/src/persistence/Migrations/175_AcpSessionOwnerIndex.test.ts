import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("uses the ACP owner index without scanning the provider threads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const plan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
      SELECT provider.thread_id FROM orchestration_v2_projection_provider_threads AS provider
      JOIN (SELECT thread_id, deleted_at FROM orchestration_v2_projection_threads) AS thread ON thread.thread_id = provider.thread_id
      WHERE provider.provider_instance_id = 'instance'
        AND provider.driver = 'acpRegistry'
        AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = 'native'
        AND thread.deleted_at IS NULL LIMIT 1`;
    assert.isTrue(plan.some((row) => row.detail.includes("acp_session_owner_idx")));
    assert.isFalse(plan.some((row) => /SCAN/i.test(row.detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
