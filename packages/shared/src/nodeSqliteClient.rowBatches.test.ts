import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const queryWorkers = vi.hoisted(() => ({
  reader: [] as Array<NodeWorkerThreads.Worker>,
  writer: [] as Array<NodeWorkerThreads.Worker>,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      const source = typeof args[0] === "string" ? args[0] : "";
      if (source.includes("database reader is unavailable")) queryWorkers.reader.push(this);
      if (source.includes("Writer unavailable")) queryWorkers.writer.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker, default: { ...actual, Worker: RecordedWorker } };
});

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-row-batches-" });
  return path.join(directory, "state.sqlite");
});

it.effect.each([false, true])("batches worker results without losing rows (reader=%s)", (reader) =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const route = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        reader ? effect.pipe(SqliteClient.readOnly) : effect;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* route(sql`SELECT 1`);
      const worker = (reader ? queryWorkers.reader : queryWorkers.writer).at(-1);
      if (worker === undefined) return assert.fail("no query worker started");
      const batches: Array<ReadonlyArray<unknown>> = [];
      const record = (reply: { rows?: ReadonlyArray<unknown> }) => {
        if (Array.isArray(reply.rows) && reply.rows.length > 0) batches.push(reply.rows);
      };
      worker.prependListener("message", record);
      yield* Effect.gen(function* () {
        const text = "x".repeat(16 * 1024);
        const query = sql<{ n: number; text: string }>`
          WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 300
          ) SELECT n, ${text} AS text FROM sequence
        `;
        const rows = yield* reader ? route(query.values) : query;
        assert.equal(rows.length, 300);
        for (const [index, row] of rows.entries()) {
          assert.deepEqual(row, reader ? [index + 1, text] : { n: index + 1, text });
        }
        assert.isAbove(batches.length, 1);
        for (const batch of batches) {
          assert.isAtMost(batch.length, 16_384);
          assert.isAtMost(batch.length * text.length * 2, 8 * 1024 * 1024);
        }
        batches.length = 0;
        const narrow = sql<{ n: number }>`
          WITH RECURSIVE sequence(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 10000
          ) SELECT n FROM sequence
        `;
        const narrowRows = yield* reader ? route(narrow.values) : narrow;
        assert.equal(narrowRows.length, 10_000);
        assert.deepEqual(narrowRows.at(-1), reader ? [10_000] : { n: 10_000 });
        assert.equal(batches.length, 1);
      }).pipe(Effect.ensuring(Effect.sync(() => worker.off("message", record))));
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename, writerWorker: true, readerWorker: true })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reuses a worker query after an iterator constraint failure", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unique_entries(name TEXT UNIQUE)`;
      const insert = (name: string) =>
        sql<{ name: string }>`INSERT INTO unique_entries VALUES (${name}) RETURNING name`;
      yield* insert("first");
      const error = yield* insert("first").pipe(Effect.flip);
      assert.equal(error.reason._tag, "UniqueViolation");
      assert.deepEqual(yield* insert("second"), [{ name: "second" }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
