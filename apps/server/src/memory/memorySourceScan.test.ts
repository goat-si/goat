import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import {
  eligibleSourceMessages,
  MEMORY_SOURCE_SCAN_PAGE_EVENTS,
  scanSourceStream,
} from "./memorySourceScan.ts";

const thread = "thread:source";
const database = NodeSqliteClient.layer({ filename: ":memory:" });

// A deterministic stream mixing every case the eligibility rules distinguish: repeated message
// versions, streaming and blank text, roles, rolled-back and unfinished runs, id-less rows,
// unrelated events, and a second stream interleaved with the first.
const seedStream = (messages: number, fillerPerMessage: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
    yield* sql`CREATE INDEX idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind, stream_id, sequence)`;
    const statuses = ["running", "completed", "rolled_back", "failed", "completed", null];
    const roles = ["user", "assistant", "assistant", "system"];
    let sequence = 0;
    const insert = (stream: string, type: string, payload: unknown) => {
      sequence += 1;
      return sql`INSERT INTO orchestration_events VALUES (${sequence},${`event-${sequence}`},${stream},${type},${JSON.stringify(payload)},'2026-10-27T00:00:00.000Z',2,'thread')`;
    };
    for (let i = 0; i < messages; i++) {
      const runId = i % 11 === 0 ? null : `run-${(i * 7) % 23}`;
      yield* insert(thread, "message.updated", {
        ...(i % 97 === 0 ? {} : { id: `message-${(i * 13) % Math.ceil((messages * 2) / 3)}` }),
        runId,
        role: roles[i % roles.length],
        text: i % 17 === 0 ? "   " : `text ${i}`,
        streaming: i % 5 === 0,
      });
      if (i % 3 === 0)
        yield* insert(thread, i % 2 ? "run.updated" : "run.created", {
          id: `run-${(i * 5) % 23}`,
          status: statuses[i % statuses.length],
        });
      for (let f = 0; f < fillerPerMessage; f++)
        yield* insert(
          f % 2 ? thread : "thread:other",
          f % 2 ? "turn-item.updated" : "message.updated",
          {
            id: `message-${i % 50}`,
            role: "user",
            text: "other",
          },
        );
    }
    return sequence;
  });

// The correlated query the worker ran before the scan, kept as the reference semantics.
const legacyReadSource = (input: {
  after: number;
  through: number;
  observed: number;
  exclusions: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ sequence: number }>`
      SELECT e.sequence FROM orchestration_events e
      WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=${thread}
      AND e.event_type='message.updated' AND e.sequence>${input.after} AND e.sequence<=${input.through}
      AND coalesce(json_extract(e.payload_json,'$.streaming'),0)=0 AND trim(json_extract(e.payload_json,'$.text'))!=''
      AND json_extract(e.payload_json,'$.role') IN ('user','assistant')
      AND json_extract(e.payload_json,'$.id') NOT IN (SELECT value FROM json_each(${JSON.stringify(input.exclusions)}))
      AND NOT EXISTS (SELECT 1 FROM orchestration_events n WHERE n.application_event_version=2 AND n.aggregate_kind='thread' AND n.stream_id=e.stream_id AND n.event_type='message.updated' AND json_extract(n.payload_json,'$.id')=json_extract(e.payload_json,'$.id') AND n.sequence>e.sequence AND n.sequence<=${input.observed})
      AND (CASE WHEN json_extract(e.payload_json,'$.runId') IS NULL THEN '' ELSE coalesce((SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') AND r.sequence<=${input.observed} ORDER BY r.sequence DESC LIMIT 1),'') END)!='rolled_back'
      AND (json_extract(e.payload_json,'$.role')='user' OR (SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') AND r.sequence<=${input.observed} ORDER BY r.sequence DESC LIMIT 1)='completed')
      ORDER BY e.sequence`;
    return rows.map((row) => row.sequence);
  });

const legacyEvidenceCount = (ids: ReadonlyArray<string>, through: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT count(*) AS count FROM orchestration_events e
      WHERE e.application_event_version=2 AND e.aggregate_kind='thread' AND e.stream_id=${thread}
      AND e.event_type='message.updated' AND e.sequence<=${through}
      AND json_extract(e.payload_json,'$.id') IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
      AND coalesce(json_extract(e.payload_json,'$.streaming'),0)=0 AND trim(json_extract(e.payload_json,'$.text'))!=''
      AND json_extract(e.payload_json,'$.role') IN ('user','assistant')
      AND NOT EXISTS (SELECT 1 FROM orchestration_events n WHERE n.application_event_version=2 AND n.aggregate_kind='thread' AND n.stream_id=e.stream_id AND n.event_type='message.updated' AND json_extract(n.payload_json,'$.id')=json_extract(e.payload_json,'$.id') AND n.sequence>e.sequence)
      AND (CASE WHEN json_extract(e.payload_json,'$.runId') IS NULL THEN '' ELSE coalesce((SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') ORDER BY r.sequence DESC LIMIT 1),'') END)!='rolled_back'
      AND (json_extract(e.payload_json,'$.role')='user' OR (SELECT json_extract(r.payload_json,'$.status') FROM orchestration_events r WHERE r.application_event_version=2 AND r.aggregate_kind='thread' AND r.stream_id=e.stream_id AND r.event_type IN ('run.created','run.updated') AND json_extract(r.payload_json,'$.id')=json_extract(e.payload_json,'$.runId') ORDER BY r.sequence DESC LIMIT 1)='completed')`;
    return rows[0]!.count;
  });

const scanned = (input: {
  after: number;
  through: number;
  observed: number | null;
  exclusions?: ReadonlyArray<string>;
  ids?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scan = yield* scanSourceStream(sql, {
      threadId: thread,
      afterSequence: input.after,
      throughSequence: input.through,
      observedSequence: input.observed,
    });
    return eligibleSourceMessages(scan, {
      excluded: new Set(input.exclusions ?? []),
      ...(input.ids ? { ids: new Set(input.ids) } : {}),
    }).map((message) => message.sequence);
  });

describe("memory source scan", () => {
  it.effect("selects exactly what the correlated source query selected", () =>
    Effect.gen(function* () {
      const last = yield* seedStream(3000, 1);
      const cases = [
        { after: 0, through: last, observed: last, exclusions: [] },
        { after: 0, through: Math.floor(last / 2), observed: last, exclusions: [] },
        {
          after: Math.floor(last / 3),
          through: Math.floor(last / 2),
          observed: last,
          exclusions: [],
        },
        {
          after: 1200,
          through: last - 500,
          observed: last - 100,
          exclusions: ["message-4", "message-77", "message-300"],
        },
      ];
      for (const input of cases) {
        const expected = yield* legacyReadSource(input);
        assert.isAbove(expected.length, 20);
        assert.deepStrictEqual(yield* scanned(input), expected);
      }
    }).pipe(Effect.provide(database)),
  );

  it.effect("validates evidence exactly as the correlated count did", () =>
    Effect.gen(function* () {
      const last = yield* seedStream(2000, 0);
      const current = yield* scanned({ after: 0, through: last, observed: null });
      const sql = yield* SqlClient.SqlClient;
      const idsAt = (sequences: ReadonlyArray<number>) =>
        sql<{
          id: string;
        }>`SELECT json_extract(payload_json,'$.id') AS id FROM orchestration_events WHERE sequence IN (SELECT value FROM json_each(${JSON.stringify(sequences)})) AND json_extract(payload_json,'$.id') IS NOT NULL`.pipe(
          Effect.map((rows) => [...new Set(rows.map((row) => row.id))]),
        );
      // Current ids, ids mixed with superseded or ineligible ones, and an unknown id.
      const samples = [
        yield* idsAt(current.slice(0, 40)),
        yield* idsAt([...current.slice(10, 20), 3, 4, 5, 6, 7, 8, 9, 10, 11]),
        ["message-unknown", ...(yield* idsAt(current.slice(0, 2)))],
      ];
      for (const ids of samples)
        for (const through of [Math.floor(last / 2), last]) {
          const count = (yield* scanned({ after: 0, through: last, observed: null, ids })).filter(
            (sequence) => sequence <= through,
          ).length;
          assert.strictEqual(count, yield* legacyEvidenceCount(ids, through));
        }
    }).pipe(Effect.provide(database)),
  );

  it.effect("bounds each statement to one page, so work grows linearly with the stream", () =>
    Effect.gen(function* () {
      const counts: number[] = [];
      for (const messages of [1000, 4000]) {
        const statements = yield* Effect.gen(function* () {
          const last = yield* seedStream(messages, 1);
          let count = 0;
          const observe: Statement.Transformer = (statement) => {
            count += 1;
            return Effect.succeed(statement);
          };
          yield* scanned({ after: 0, through: last, observed: last }).pipe(
            Effect.provideService(Statement.CurrentTransformer, observe),
          );
          // Each page is one index-only boundary read plus one read of at most a page of events.
          const events = (yield* (yield* SqlClient.SqlClient)<{
            count: number;
          }>`SELECT count(*) AS count FROM orchestration_events WHERE stream_id=${thread}`)[0]!
            .count;
          assert.strictEqual(count, 2 * (Math.floor(events / MEMORY_SOURCE_SCAN_PAGE_EVENTS) + 1));
          return count;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
        counts.push(statements);
      }
      assert.isAtMost(counts[1]!, 4 * counts[0]!);
    }),
  );
});
