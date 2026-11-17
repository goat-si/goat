import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const checkpointWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      if (typeof args[0] === "string" && args[0].includes("truncate-request")) {
        checkpointWorkers.push(this);
      }
    }
  }
  return { ...actual, Worker: RecordedWorker, default: { ...actual, Worker: RecordedWorker } };
});

const PAYLOAD = new Uint8Array(1024 * 1024).fill(7);
const WAL_SIZE_LIMIT = 32 * 1024 * 1024;

// Fails instead of hanging when admission holds the write: the worker retries a blocked
// checkpoint on its own, so two blocked reports for one WAL generation mean a held write.
const insertUnlessHeld = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  worker: NodeWorkerThreads.Worker,
  label: string,
) {
  const stalled = yield* Deferred.make<void>();
  let seen: unknown;
  const onMessage = (message: { type?: unknown; blocked?: unknown; generation?: unknown }) => {
    if (message?.type !== "checkpoint" || message.blocked !== true) return;
    if (message.generation === seen) Deferred.doneUnsafe(stalled, Effect.void);
    seen = message.generation;
  };
  worker.on("message", onMessage);
  const held = yield* Effect.raceFirst(
    sql`INSERT INTO blobs VALUES (${PAYLOAD})`.pipe(Effect.as(false)),
    Deferred.await(stalled).pipe(Effect.as(true)),
  ).pipe(Effect.ensuring(Effect.sync(() => worker.off("message", onMessage))));
  if (held) assert.fail(`${label} is held by admission while an outside reader pins the WAL`);
});

// `outside` stands in for `sqlite3 statev2.sqlite` or a backup script reading the database.
const withOutsideConnection = <A, E>(
  use: (options: {
    readonly sql: SqlClient.SqlClient;
    readonly worker: NodeWorkerThreads.Worker;
    readonly outside: NodeSqlite.DatabaseSync;
    readonly walSize: Effect.Effect<number>;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-pinned-wal-" });
    const filename = path.join(directory, "state.sqlite");
    const outside = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (db) =>
        Effect.sync(() => {
          if (db.isTransaction) db.exec("COMMIT");
          db.close();
        }),
    );
    outside.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE blobs(data BLOB NOT NULL);
    `);
    const walSize = fs.stat(`${filename}-wal`).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orDie,
    );
    const before = checkpointWorkers.length;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
      const worker = checkpointWorkers[before];
      if (worker === undefined) return assert.fail("the client started no checkpoint worker");
      return yield* use({ sql, worker, outside, walSize });
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const openReadTransaction = (db: NodeSqlite.DatabaseSync) => {
  db.exec("BEGIN");
  db.prepare("SELECT COUNT(*) FROM blobs").get();
};

it.effect("keeps admitting writes while an outside read transaction pins the WAL", () =>
  withOutsideConnection(({ sql, worker, outside }) =>
    Effect.gen(function* () {
      yield* sql`INSERT INTO blobs VALUES (${PAYLOAD})`;
      openReadTransaction(outside);
      // 140 MiB passes both the 32 MiB size limit and the 32,768-frame ceiling.
      for (let write = 1; write <= 140; write++) {
        yield* insertUnlessHeld(sql, worker, `write ${write}`);
      }
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM blobs`;
      assert.equal(rows[0]?.count, 141);
    }),
  ),
);

it.effect("keeps admitting writes while a reader stops TRUNCATE, then resets the WAL", () =>
  withOutsideConnection(({ sql, worker, outside, walSize }) =>
    Effect.gen(function* () {
      const insert = outside.prepare("INSERT INTO blobs VALUES (?)");
      for (let write = 1; write <= 40; write++) insert.run(PAYLOAD);
      // A snapshot of an unbackfilled WAL lets PASSIVE finish but stops TRUNCATE.
      openReadTransaction(outside);
      const stopped = yield* Deferred.make<void>();
      const reset = yield* Deferred.make<void>();
      worker.on("message", (message: { type?: unknown; truncateId?: unknown; log?: unknown }) => {
        if (message?.type !== "checkpoint" || message.truncateId === undefined) return;
        Deferred.doneUnsafe(message.log === 0 ? reset : stopped, Effect.void);
      });
      // Starts a checkpoint without appending a frame past the reader's snapshot.
      yield* sql`DELETE FROM blobs WHERE 0`;
      yield* Deferred.await(stopped);
      yield* insertUnlessHeld(sql, worker, "a write after the failed TRUNCATE");
      assert.isAbove(yield* walSize, WAL_SIZE_LIMIT);
      outside.exec("COMMIT");
      // No further write arrives; the worker has to retry on its own.
      yield* Deferred.await(reset);
      assert.equal(yield* walSize, 0);
    }),
  ),
);
