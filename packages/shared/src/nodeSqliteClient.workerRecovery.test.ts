import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (failingWorkers.message !== undefined) {
        args = [`throw new Error(${JSON.stringify(failingWorkers.message)})`, { eval: true }];
      }
      super(...args);
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const checkpointWorkerReply = (worker: NodeWorkerThreads.Worker) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const stop = () => {
          worker.off("message", onReply);
          worker.off("error", onError);
          worker.off("exit", onExit);
        };
        const onReply = (reply: unknown) => {
          if (reply !== "barrier") return;
          stop();
          resolve();
        };
        const onError = (cause: Error) => {
          stop();
          reject(new Error(`checkpoint worker failed: ${cause.stack ?? cause.message}`));
        };
        const onExit = (code: number) => {
          stop();
          reject(new Error(`checkpoint worker exited with code ${code}`));
        };
        if (worker.threadId === -1) {
          reject(new Error("checkpoint worker had already exited"));
          return;
        }
        worker.on("message", onReply);
        worker.on("error", onError);
        worker.on("exit", onExit);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
      }),
  );

it.effect("retries reader startup after backoff without ever using the writer", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const failedWorker = startedWorkers.at(-1)!;
      yield* Effect.promise(() => failedWorker.terminate());
      const attempts = startedWorkers.length;
      const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
        startImmediately: true,
      });
      assert.equal(startedWorkers.length, attempts);
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* Fiber.join(read), 1);
      assert.equal(startedWorkers.length, attempts + 1);
      const readonlyError = yield* sql`INSERT INTO entries VALUES ('forbidden')`.pipe(
        SqliteClient.readOnly,
        Effect.flip,
      );
      assert.equal(readonlyError._tag, "SqlError");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("retires cancelled native reader work before another reader can run", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const sent = yield* Deferred.make<void>();
      using held = vi.spyOn(worker, "postMessage").mockImplementation(() => {
        Deferred.doneUnsafe(sent, Effect.void);
        // Deliberately hold the outbound native request until the owning worker is retired.
      });
      using terminated = vi.spyOn(worker, "terminate");
      const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly));
      yield* Deferred.await(sent);
      yield* Fiber.interrupt(read);
      assert.equal(terminated.mock.calls.length, 1);
      held.mockRestore();
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("bounds reader admission before the connection semaphore", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      using held = vi.spyOn(worker, "postMessage").mockImplementation(() => {});
      const reads = [];
      for (let index = 0; index < 64; index++) {
        reads.push(
          yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
            startImmediately: true,
          }),
        );
      }
      const overflow = yield* Effect.forkChild(
        countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
        { startImmediately: true },
      );
      const state = overflow.pollUnsafe();
      assert.isDefined(state, "overflow must complete without joining the reader queue");
      const result = yield* Fiber.join(overflow);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      const rejected = result.failure;
      assert.equal(rejected._tag, "SqlError");
      assert.include(String(rejected.reason.cause), "Reader admission limit reached");
      for (const read of reads) yield* Fiber.interrupt(read);
    }),
  ),
);

it.effect("keeps autocheckpoints disabled while a checkpoint worker recovers", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE recovery_probe(value INTEGER)`;
      const worker = startedWorkers.at(-1)!;
      yield* checkpointWorkerReply(worker);
      yield* Effect.promise(() => worker.terminate());
      // This read does not mutate, so it bypasses WAL write admission.
      assert.equal((yield* sql`PRAGMA wal_autocheckpoint`)[0]?.wal_autocheckpoint, 0);
      const inserted = yield* Effect.forkChild(sql`INSERT INTO recovery_probe VALUES (1)`, {
        startImmediately: true,
      });
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(inserted);
      assert.deepEqual(yield* sql`SELECT value FROM recovery_probe`, [{ value: 1 }]);
      assert.equal((yield* sql`PRAGMA wal_autocheckpoint`)[0]?.wal_autocheckpoint, 0);
    }),
  ),
);
