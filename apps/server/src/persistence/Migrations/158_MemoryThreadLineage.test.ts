import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const space = "00000000-0000-4000-8000-000000000001";
const revisions = ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000002"];

const seed = Effect.fn("MemoryThreadLineage.test.seed")(function* (
  threadId: string,
  state: string,
  entries: readonly string[] = revisions,
) {
  const sql = yield* SqlClient.SqlClient;
  const id = `memory:thread-lineage:${JSON.stringify(["env", threadId])}`;
  yield* sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at)
    VALUES (${id},'_worker','rebuild','completed',${JSON.stringify({
      kind: "threadLineage",
      sourceThread: { environmentId: "env", threadId },
      memorySpaceId: space,
      state,
      revisions: entries,
    })},0)`;
});

it.effect("backfills lineage states and ordered revisions from the outbox", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 157 });
    yield* seed("a", "tracked");
    yield* seed("b", "unknown", []);
    yield* seed("c", "overflow");
    assert.deepStrictEqual(yield* runMigrations(), [[158, "MemoryThreadLineage"]]);
    assert.deepStrictEqual(
      yield* sql`SELECT thread_id,space,state,count FROM memory_thread_lineages ORDER BY thread_id`,
      [
        { thread_id: "a", space, state: "tracked", count: 2 },
        { thread_id: "b", space, state: "unknown", count: 0 },
        { thread_id: "c", space, state: "overflow", count: 2 },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT revision_id FROM memory_thread_lineage_revisions
        WHERE environment_id='env' AND thread_id='a' ORDER BY ordinal`,
      revisions.map((revision_id) => ({ revision_id })),
    );
    assert.deepStrictEqual(yield* sql`SELECT id FROM memory_outbox`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects malformed lineage without echoing its contents or removing old rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 157 });
    yield* seed("a", "tracked");
    yield* seed("b", "private-marker");
    const error = yield* Effect.flip(runMigrations());
    assert.notInclude(error.message, "private-marker");
    assert.lengthOf(yield* sql`SELECT id FROM memory_outbox`, 2);
    assert.lengthOf(
      yield* sql`SELECT name FROM sqlite_master WHERE name='memory_thread_lineages'`,
      0,
    );
    assert.lengthOf(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id=158`, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
