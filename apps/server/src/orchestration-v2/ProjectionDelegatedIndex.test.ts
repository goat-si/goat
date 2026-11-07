import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

it.effect("uses the delegated child partial index when selecting recovery candidates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* sql`CREATE INDEX test_subagent_result_idx ON orchestration_v2_projection_threads(thread_id, json_extract(payload_json, '$.lineage.parentThreadId')) WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent' AND json_extract(payload_json, '$.lineage.parentThreadId') IS NOT NULL AND json_extract(payload_json, '$.forkedFrom.type') = 'node' ELSE 0 END`;
    const statements: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
    const result = yield* store.getRecoveryThreadIds("subagent-results").pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        statements.push(statement.compile());
        return Effect.succeed(statement);
      }),
    );
    assert.deepEqual(result, []);
    const [query, params] = statements[0]!;
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
    assert.isTrue(
      plan.some((row) => row.detail.includes("test_subagent_result_idx")),
      JSON.stringify(plan),
    );
  }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
