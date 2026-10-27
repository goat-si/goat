import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
// Threads 0-19 went idle 30 down to 11 days ago, oldest first; 20-23 were last active 26 h ago.
const idleDays = (thread: number) => (thread < 20 ? 30 - thread : 1 + 1 / 12);
const outputBytes = 32_000;

const layer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeServices.layer),
);

it.effect.each([200, 800])(
  "skips modern receipt sweep when no imported legacy receipt is eligible (%i receipts)",
  (receiptCount) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* sql`WITH RECURSIVE n(i) AS (
          SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${receiptCount}
        ) INSERT INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, accepted_at,
           result_sequence, status, command_type)
          SELECT 'modern-' || i, 'thread', 'thread-' || i,
            '2026-10-01', i, 'accepted', 'thread.settle' FROM n`;
      const queries: string[] = [];
      const record: Statement.Transformer = (statement) => {
        queries.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      const compact = maintenance
        .compactEventStore()
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      const retained =
        yield* sql`SELECT command_id FROM orchestration_command_receipts ORDER BY command_id`;

      assert.equal((yield* compact).deletedReceiptCount, 0);
      assert.deepEqual(
        queries.filter((query) => /receipt\.rowid AS row_id/u.test(query)),
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT command_id FROM orchestration_command_receipts ORDER BY command_id`,
        retained,
      );
      const boundsQuery = queries.find((query) => query.includes("AS receipt_row_id"));
      assert.isDefined(boundsQuery);
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${boundsQuery}`,
      );
      assert.isTrue(
        plan.some((row) =>
          /SEARCH receipt USING INDEX idx_orch_command_receipts_aggregate/u.test(row.detail),
        ),
      );

      yield* sql`INSERT INTO orchestration_v2_legacy_imports
          (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
          VALUES ('thread-1', '2026-01-01', '2026-01-01', '2026-01-01'),
            ('pending', '2026-01-01', '2026-01-01', NULL)`;
      yield* sql`INSERT INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, accepted_at,
           result_sequence, status, command_type)
          VALUES ('pending-command', 'thread', 'pending', '2026-01-01', 0, 'accepted', 'legacy'),
            ('project-command', 'project', 'thread-1', '2026-01-01', 0, 'accepted', 'legacy')`;
      const ineligible =
        yield* sql`SELECT command_id FROM orchestration_command_receipts ORDER BY command_id`;
      queries.length = 0;
      assert.equal((yield* compact).deletedReceiptCount, 0);
      assert.deepEqual(
        queries.filter((query) => /receipt\.rowid AS row_id/u.test(query)),
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT command_id FROM orchestration_command_receipts ORDER BY command_id`,
        ineligible,
      );

      yield* sql`UPDATE orchestration_v2_legacy_imports
          SET transcript_imported_at = '2026-01-01' WHERE thread_id = 'pending'`;
      queries.length = 0;
      assert.equal((yield* compact).deletedReceiptCount, 1);
      assert.isAbove(queries.filter((query) => /receipt\.rowid AS row_id/u.test(query)).length, 0);
      assert.deepEqual(
        yield* sql`SELECT command_id FROM orchestration_command_receipts ORDER BY command_id`,
        ineligible.filter((row) => row.command_id !== "pending-command"),
      );

      queries.length = 0;
      assert.equal((yield* compact).deletedReceiptCount, 0);
      assert.deepEqual(
        queries.filter((query) => /receipt\.rowid AS row_id/u.test(query)),
        [],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("reports compaction pages and closes observation on interruption", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* sql`WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 120
    ) INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
      SELECT 'modern-' || i, 'thread', 'thread-' || i, '2026-10-01', i, 'accepted', 'thread.settle' FROM n`;
    yield* sql`WITH RECURSIVE n(i) AS (
      SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 70
    ) INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
       actor_kind, payload_json, metadata_json, application_event_version)
      SELECT 'event-' || i, 'thread', 'thread-' || i, 1, 'thread.created', '2026-10-01',
        'user', '{}', '{}', 2 FROM n`;
    yield* sql`INSERT INTO orchestration_v2_legacy_imports
      (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
      VALUES ('old', '2026-01-01', '2026-01-01', '2026-01-01')`;
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
      VALUES ('old-command', 'thread', 'old', '2026-01-01', 0, 'accepted', 'legacy')`;

    let active = 0;
    const pages: Array<readonly [string, number]> = [];
    const ended: boolean[] = [];
    const observed = maintenance.compactEventStore().pipe(
      Effect.provideService(ProjectionMaintenance.ProjectionMaintenanceObserver, {
        onStart: () => {
          active++;
          return {
            onPage: (kind, processedRows) => pages.push([kind, processedRows]),
            onEnd: (succeeded) => {
              active--;
              ended.push(succeeded);
            },
          };
        },
      }),
    );
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const hold: Statement.Transformer = (statement) =>
      /receipt\.rowid AS row_id/u.test(statement.compile()[0])
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(statement),
          )
        : Effect.succeed(statement);
    const fiber = yield* observed.pipe(
      Effect.provideService(Statement.CurrentTransformer, hold),
      Effect.forkChild,
    );
    yield* Deferred.await(entered);
    assert.equal(active, 1);
    assert.deepEqual(pages, [
      ["events", 50],
      ["events", 20],
    ]);
    yield* Fiber.interrupt(fiber);
    assert.equal(active, 0);
    assert.deepEqual(ended, [false]);

    pages.length = 0;
    assert.equal((yield* observed).deletedReceiptCount, 1);
    assert.equal(active, 0);
    assert.deepEqual(ended, [false, true]);
    assert.deepEqual(pages, [
      ["events", 50],
      ["events", 20],
      ["receipts", 50],
      ["receipts", 50],
      ["receipts", 21],
    ]);
    const captured = pages.slice();
    assert.equal((yield* maintenance.compactEventStore()).deletedReceiptCount, 0);
    assert.deepEqual(pages, captured);
    assert.deepEqual(ended, [false, true]);
  }).pipe(Effect.provide(layer)),
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

it.effect(
  "trims settled day-idle threads when week-idle ones cannot bring history under budget",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* seed;
      // Threads 20-23 went quiet yesterday; 23 still has a run under way.
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run-live', 'thread-23', 0, 'codex', 'running', '2026-10-21', '{}')`;
      const result = yield* maintenance.boundHistory({ budgetBytes: 0, now });
      assert.isAbove(result.trimmedRows, 0);
      const trimmedThreads = new Set(
        (yield* outputs("projection"))
          .filter((row) => isTrimmed(row.output))
          .map((row) => Number(row.thread_id.slice("thread-".length))),
      );
      for (const thread of [0, 19, 20, 21, 22])
        assert.isTrue(trimmedThreads.has(thread), `${thread}`);
      assert.isFalse(trimmedThreads.has(23));
    }).pipe(Effect.provide(layer)),
);
