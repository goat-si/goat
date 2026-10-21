import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const now = Date.parse("2026-10-22T00:00:00.000Z");
const day = 86_400_000;
const threads = 24;
const items = 20;
// Threads 0-19 went idle 30 down to 11 days ago, oldest first; 20-23 were active yesterday.
const idleDays = (thread: number) => (thread < 20 ? 30 - thread : 1);
const outputBytes = 32_000;

const layer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

// Every command item has a full projection row, an in-progress event and a final event, each
// with output well above the trim size, plus one long assistant message that must survive.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let thread = 0; thread < threads; thread++) {
    const threadId = `thread-${thread}`;
    const at = DateTime.formatIso(DateTime.makeUnsafe(now - idleDays(thread) * day));
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, 'project', ${threadId}, 'codex', 'full-access', 'default', ${at}, ${at}, '{}')`;
    yield* sql`WITH RECURSIVE k(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM k WHERE n < ${items})
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
      SELECT ${threadId} || ':item-' || n, ${threadId}, n,
        CASE WHEN n = ${items} THEN 'assistant_message' ELSE 'command_execution' END, 'completed', ${at},
        CASE WHEN n = ${items}
          THEN json_object('id', ${threadId} || ':item-' || n, 'type', 'assistant_message', 'text', printf('%.*c', CAST(${outputBytes} AS INTEGER), 'm'))
          ELSE json_object('id', ${threadId} || ':item-' || n, 'type', 'command_execution', 'input', 'make',
            'output', 'HEAD' || printf('%.*c', CAST(${outputBytes} AS INTEGER), 'x') || 'TAIL') END
      FROM k`;
    yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
      SELECT thread_id, turn_item_id, ordinal FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
    yield* sql`WITH RECURSIVE k(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM k WHERE n < ${2 * items})
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      SELECT ${threadId} || ':event-' || n, 'thread', ${threadId}, n + 1,
        CASE WHEN n < ${2 * items} THEN 'turn-item.updated' ELSE 'message.updated' END, ${at}, 'provider',
        CASE WHEN n < ${2 * items}
          THEN json_object('id', ${threadId} || ':item-' || (n / 2), 'type', 'command_execution', 'input', 'make',
            'output', 'HEAD' || printf('%.*c', CAST(CASE WHEN n % 2 = 0 THEN ${outputBytes * 0.75} ELSE ${outputBytes} END AS INTEGER), 'x') || 'TAIL')
          ELSE json_object('id', 'message', 'text', printf('%.*c', CAST(${outputBytes} AS INTEGER), 'm')) END,
        '{}', 2
      FROM k`;
  }
});

const outputs = (table: "projection" | "events") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return table === "projection"
      ? yield* sql<{ readonly thread_id: string; readonly output: string }>`
          SELECT thread_id, json_extract(payload_json, '$.output') AS output
          FROM orchestration_v2_projection_turn_items WHERE type = 'command_execution'`
      : yield* sql<{ readonly thread_id: string; readonly output: string }>`
          SELECT stream_id AS thread_id, json_extract(payload_json, '$.output') AS output
          FROM orchestration_events WHERE event_type = 'turn-item.updated'`;
  });

const isTrimmed = (output: string) => /\n… output trimmed, \d+ KB …\n/u.test(output);

it.effect("trims tool output in the oldest idle threads until history fits its budget", () => {
  const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
  const record: Statement.Transformer = (statement) => {
    statements.push(statement.compile() as readonly [string, ReadonlyArray<unknown>]);
    return Effect.succeed(statement);
  };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* seed;
    const measure = maintenance
      .boundHistory({ budgetBytes: Number.MAX_SAFE_INTEGER, now })
      .pipe(Effect.map((result) => result.historyBytes));
    // The same shape as a 3 GB history against its 2 GB budget.
    const before = yield* measure;
    const budgetBytes = Math.floor((before * 2) / 3);
    const result = yield* maintenance
      .boundHistory({ budgetBytes, now })
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.equal(result.historyBytes, before);
    assert.isAtLeast(result.reclaimedBytes, before - budgetBytes);
    assert.isAtMost(yield* measure, budgetBytes);

    for (const table of ["projection", "events"] as const) {
      const rows = yield* outputs(table);
      const trimmedThreads = new Set(
        rows.filter((row) => isTrimmed(row.output)).map((row) => row.thread_id),
      );
      // Oldest first: the trimmed threads are a prefix of the idle threads by age.
      const order = [...trimmedThreads]
        .map((id) => Number(id.slice("thread-".length)))
        .sort((a, b) => a - b);
      assert.deepEqual(
        order,
        order.map((_, index) => index),
      );
      assert.isAbove(order.length, 0);
      assert.isBelow(order.length, 20);
      for (const row of rows) {
        if (!isTrimmed(row.output)) continue;
        assert.isAtMost(Buffer.byteLength(row.output, "utf8"), 8192);
        assert.isTrue(row.output.startsWith("HEAD") && row.output.endsWith("TAIL"));
      }
    }
    // Recent threads and messages are never touched.
    const recent = (yield* outputs("projection")).filter(
      (row) => Number(row.thread_id.slice(7)) >= 20,
    );
    assert.isTrue(recent.every((row) => !isTrimmed(row.output)));
    const messages = yield* sql<{ readonly bytes: number }>`
      SELECT length(json_extract(payload_json, '$.text')) AS bytes FROM orchestration_v2_projection_turn_items
      WHERE type = 'assistant_message'`;
    assert.isTrue(messages.every((row) => row.bytes === outputBytes));

    // No statement in the pass reaches past one page of rows.
    for (const [query, params] of statements) {
      if (!/orchestration_events|orchestration_v2_projection_turn_items/u.test(query)) continue;
      const inList = /\bIN \(([?, ]+)\)/u.exec(query);
      const limit = /\bLIMIT \?/u.test(query) ? Number(params.at(-1)) : undefined;
      const byKey = /WHERE (sequence|turn_item_id) = \?$/u.test(query.trim());
      assert.isTrue(
        (limit !== undefined && limit <= ProjectionMaintenance.HISTORY_PAGE_ROWS) ||
          (inList !== null &&
            inList[1]!.split(",").length <= ProjectionMaintenance.HISTORY_PAGE_ROWS) ||
          byKey,
        JSON.stringify([query.replace(/\s+/g, " "), params.length]),
      );
    }

    // A second pass under budget has nothing left to do.
    const again = yield* maintenance.boundHistory({
      budgetBytes,

      now,
    });
    assert.equal(again.trimmedRows, 0);
  }).pipe(Effect.provide(layer));
});
