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
const workerStarts = vi.hoisted(() => ({
  onStart: undefined as ((worker: NodeWorkerThreads.Worker) => void) | undefined,
}));
const nativeRead = vi.hoisted(() => ({ latch: undefined as SharedArrayBuffer | undefined }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (failingWorkers.message !== undefined) {
        args = [`throw new Error(${JSON.stringify(failingWorkers.message)})`, { eval: true }];
      }
      if (nativeRead.latch !== undefined && typeof args[0] === "string") {
        args[0] =
          `
          const sqlite = require("node:sqlite");
          const Original = sqlite.DatabaseSync;
          sqlite.DatabaseSync = class extends Original {
            constructor(...args) {
              super(...args);
              this.function("hold_reader", () => {
                const { parentPort, workerData } = require("node:worker_threads");
                parentPort.postMessage({ type: "native-active" });
                Atomics.wait(new Int32Array(workerData.nativeReadLatch), 0, 0);
                return 1;
              });
            }
          };
        ` + args[0];
        args[1] = {
          ...args[1],
          workerData: { ...args[1]?.workerData, nativeReadLatch: nativeRead.latch },
        };
      }
      super(...args);
      startedWorkers.push(this);
      workerStarts.onStart?.(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
  config: Partial<SqliteClient.SqliteClientConfig> = {},
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
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true, ...config })));
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
      using _held = vi.spyOn(worker, "postMessage").mockImplementation(() => {});
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

it.effect("caps repeated reader startup backoff and resets it after a successful read", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      failingWorkers.message = "startup fault";
      yield* Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly, Effect.flip);
        for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000]) {
          const before = startedWorkers.length;
          const read = yield* Effect.forkChild(
            countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
            { startImmediately: true },
          );
          yield* TestClock.adjust(`${delay - 1} millis`);
          assert.equal(startedWorkers.length, before);
          yield* TestClock.adjust("1 millis");
          assert.equal((yield* Fiber.join(read))._tag, "Failure");
          assert.equal(startedWorkers.length, before + 1);
        }
        failingWorkers.message = undefined;
        const recovered = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        yield* TestClock.adjust("8 seconds");
        assert.equal(yield* Fiber.join(recovered), 1);
        yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
        const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        yield* TestClock.adjust("250 millis");
        assert.equal(yield* Fiber.join(read), 1);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            failingWorkers.message = undefined;
          }),
        ),
      );
    }),
  ),
);

it.effect("cancels reader startup waiters and releases all their admission slots", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const original = startedWorkers.length;
      const created = yield* Effect.forkChild(nextStartedWorker, { startImmediately: true });
      const read = yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
        { startImmediately: true },
      );
      const worker = yield* Fiber.join(created);
      // Startup has posted initialize, but its reply is held at the worker boundary.
      using messages = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
        if (event === "message") {
          Deferred.doneUnsafe(started, Effect.void);
          return true;
        }
        return Reflect.apply(Object.getPrototypeOf(Object.getPrototypeOf(worker)).emit, worker, [
          event,
          ...args,
        ]);
      });
      yield* Deferred.await(started);
      const reads = [];
      for (let index = 0; index < 63; index++)
        reads.push(
          yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
            { startImmediately: true },
          ),
        );
      for (const waiting of reads) yield* Fiber.interrupt(waiting);
      yield* Fiber.interrupt(read);
      messages.mockRestore();
      worker.emit("message", { type: "ready" });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, original + 1);
      using _held = vi.spyOn(worker, "postMessage").mockImplementation(() => {});
      const admitted = [];
      for (let index = 0; index < 64; index++) {
        const waiting = yield* Effect.forkChild(
          countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
          { startImmediately: true },
        );
        assert.isUndefined(waiting.pollUnsafe());
        admitted.push(waiting);
      }
      for (const waiting of admitted) yield* Fiber.interrupt(waiting);
    }),
  ),
);

it.effect("retires a startup deadline epoch and ignores its late ready message", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const created = yield* Effect.forkChild(nextStartedWorker, { startImmediately: true });
      const read = yield* Effect.forkChild(
        countEntries(sql).pipe(SqliteClient.readOnly, Effect.result),
        { startImmediately: true },
      );
      const worker = yield* Fiber.join(created);
      const emit = worker.emit.bind(worker);
      const readyHeld = yield* Deferred.make<void>();
      using held = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
        if (event === "message") {
          Deferred.doneUnsafe(readyHeld, Effect.void);
          return true;
        }
        return emit(event, ...args);
      });
      yield* Deferred.await(readyHeld);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(read))._tag, "Failure");
      assert.equal(worker.threadId, -1);
      held.mockRestore();
      worker.emit("message", { type: "ready" });
      yield* TestClock.adjust("250 millis");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.notEqual(startedWorkers.at(-1), worker);
    }),
  ),
);

it.effect(
  "waits for executing native read retirement before releasing its pinned transaction",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const latch = new SharedArrayBuffer(4);
        nativeRead.latch = latch;
        return new Int32Array(latch);
      }),
      (latch) =>
        withReaderClient((sql) =>
          Effect.gen(function* () {
            yield* countEntries(sql).pipe(SqliteClient.readOnly);
            const worker = startedWorkers.at(-1)!;
            const active = yield* Deferred.make<void>();
            worker.on("message", (reply) => {
              if (reply?.type === "native-active") Deferred.doneUnsafe(active, Effect.void);
            });
            const transaction = yield* Effect.forkChild(
              sql
                .withTransaction(
                  Effect.gen(function* () {
                    yield* countEntries(sql);
                    yield* sql`SELECT hold_reader()`;
                  }),
                )
                .pipe(SqliteClient.readOnly),
            );
            yield* Deferred.await(active);
            using terminated = vi.spyOn(worker, "terminate");
            const cancellation = yield* Effect.forkChild(Fiber.interrupt(transaction), {
              startImmediately: true,
            });
            assert.equal(terminated.mock.calls.length, 1);
            const before = startedWorkers.length;
            const replacement = yield* Effect.forkChild(
              countEntries(sql).pipe(SqliteClient.readOnly),
              { startImmediately: true },
            );
            assert.equal(startedWorkers.length, before);
            Atomics.store(latch, 0, 1);
            Atomics.notify(latch, 0);
            yield* Fiber.join(cancellation);
            assert.equal(worker.threadId, -1);
            yield* TestClock.adjust("250 millis");
            assert.equal(yield* Fiber.join(replacement), 1);
            yield* sql`INSERT INTO entries VALUES ('after retirement')`;
            assert.equal((yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`)[0]?.busy, 0);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Atomics.store(latch, 0, 1);
                Atomics.notify(latch, 0);
              }),
            ),
          ),
        ),
      (latch) =>
        Effect.sync(() => {
          Atomics.store(latch, 0, 1);
          Atomics.notify(latch, 0);
          nativeRead.latch = undefined;
        }),
    ),
);

it.effect("scope close cancels a checkpoint retry before it creates another worker", () =>
  Effect.gen(function* () {
    yield* withCheckpointClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE close_probe(value INTEGER)`;
        const worker = startedWorkers.at(-1)!;
        yield* checkpointWorkerReply(worker);
        yield* Effect.promise(() => worker.terminate());
      }),
    );
    const before = startedWorkers.length;
    yield* TestClock.adjust("30 seconds");
    assert.equal(startedWorkers.length, before);
  }),
);

it.effect("ignores retired checkpoint replies until a replacement supplies fresh state", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE stale_probe(value INTEGER)`;
      const worker = startedWorkers.at(-1)!;
      yield* checkpointWorkerReply(worker);
      yield* Effect.promise(() => worker.terminate());
      const mutation = yield* Effect.forkChild(sql`INSERT INTO stale_probe VALUES (1)`, {
        startImmediately: true,
      });
      worker.emit("message", {
        type: "checkpoint",
        generation: 0,
        log: 0,
        checkpointed: 0,
        blocked: false,
      });
      worker.emit("message", { type: "ready" });
      assert.isUndefined(mutation.pollUnsafe());
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(mutation);
      assert.deepEqual(yield* sql`SELECT value FROM stale_probe`, [{ value: 1 }]);
    }),
  ),
);

it.effect("keeps in-memory and explicitly disabled readers on their inline connection", () =>
  Effect.gen(function* () {
    const before = startedWorkers.length;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE inline_probe(value INTEGER)`.pipe(SqliteClient.readOnly);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: ":memory:", readerWorker: true, checkpointWorker: true }),
      ),
      Effect.scoped,
    );
    yield* withReaderClient(
      (sql) => sql`INSERT INTO entries VALUES ('inline')`.pipe(SqliteClient.readOnly),
      { readerWorker: false },
    );
    assert.equal(startedWorkers.length, before);
  }),
);

const nextStartedWorker = Effect.callback<NodeWorkerThreads.Worker>((resume) => {
  workerStarts.onStart = (worker) => resume(Effect.succeed(worker));
  return Effect.sync(() => {
    workerStarts.onStart = undefined;
  });
});

it.effect("keeps a retired truncate fence gated until replacement checkpoint state arrives", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE truncate_recovery(value INTEGER)`;
      const old = startedWorkers.at(-1)!;
      yield* checkpointWorkerReply(old);
      old.emit("message", { type: "truncate-request", truncateId: 999 });
      yield* Effect.promise(() => old.terminate());
      const mutation = yield* Effect.forkChild(sql`INSERT INTO truncate_recovery VALUES (1)`, {
        startImmediately: true,
      });
      const created = yield* Effect.forkChild(nextStartedWorker, { startImmediately: true });
      yield* TestClock.adjust("250 millis");
      const replacement = yield* Fiber.join(created);
      const fresh = yield* Deferred.make<unknown>();
      const emit = replacement.emit.bind(replacement);
      using held = vi.spyOn(replacement, "emit").mockImplementation((event, ...args) => {
        const reply = args[0];
        if (event === "message" && reply?.type === "checkpoint") {
          Deferred.doneUnsafe(fresh, Effect.succeed(reply));
          return true;
        }
        return emit(event, ...args);
      });
      const reply = yield* Deferred.await(fresh);
      old.emit("message", {
        type: "checkpoint",
        truncateId: 999,
        log: 0,
        checkpointed: 0,
        blocked: false,
      });
      assert.isUndefined(mutation.pollUnsafe());
      held.mockRestore();
      replacement.emit("message", reply);
      yield* Fiber.join(mutation);
      assert.deepEqual(yield* sql`SELECT value FROM truncate_recovery`, [{ value: 1 }]);
    }),
  ),
);

it.effect("replaces an intentionally cancelled reader without waiting for fault backoff", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers.at(-1)!;
      const sent = yield* Deferred.make<void>();
      using held = vi.spyOn(worker, "postMessage").mockImplementation(() => {
        Deferred.doneUnsafe(sent, Effect.void);
      });
      const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly));
      yield* Deferred.await(sent);
      yield* Fiber.interrupt(read);
      assert.equal(worker.threadId, -1);
      held.mockRestore();
      const before = startedWorkers.length;
      const replacement = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
        startImmediately: true,
      });
      yield* TestClock.adjust("0 millis");
      assert.equal(startedWorkers.length, before + 1);
      assert.equal(yield* Fiber.join(replacement), 1);
    }),
  ),
);

it.effect(
  "keeps recovery admission closed after an existing transaction commits until a fresh snapshot",
  () =>
    withCheckpointClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE recovery_transaction(value INTEGER)`;
        const failed = startedWorkers.at(-1)!;
        yield* checkpointWorkerReply(failed);
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const committed = yield* Deferred.make<void>();
        const admitted = yield* Deferred.make<void>();
        const initializing = yield* Deferred.make<{
          readonly worker: NodeWorkerThreads.Worker;
          readonly initialize: () => void;
        }>();
        const transaction = yield* Effect.forkChild(
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO recovery_transaction VALUES (1)`;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(finish);
                yield* sql`INSERT INTO recovery_transaction VALUES (2)`;
              }),
            )
            .pipe(Effect.andThen(Deferred.succeed(committed, undefined))),
        );
        yield* Deferred.await(entered);
        yield* Effect.promise(() => failed.terminate());
        workerStarts.onStart = (worker) => {
          workerStarts.onStart = undefined;
          const postMessage = worker.postMessage.bind(worker);
          worker.postMessage = (...args) => {
            if (args[0]?.type !== "initialize") return postMessage(...args);
            worker.postMessage = postMessage;
            Deferred.doneUnsafe(
              initializing,
              Effect.succeed({
                worker,
                initialize: () => postMessage(...args),
              }),
            );
          };
        };
        yield* Effect.gen(function* () {
          yield* TestClock.adjust("250 millis");
          const replacement = yield* Deferred.await(initializing);
          const snapshotRequested = yield* Deferred.make<() => void>();
          const postMessage = replacement.worker.postMessage.bind(replacement.worker);
          using _heldSnapshot = vi
            .spyOn(replacement.worker, "postMessage")
            .mockImplementation((...args) => {
              if (args[0]?.type !== "check") return postMessage(...args);
              Deferred.doneUnsafe(
                snapshotRequested,
                Effect.succeed(() => postMessage(...args)),
              );
            });
          yield* Deferred.succeed(finish, undefined);
          yield* TestClock.adjust("0 millis");
          assert.isTrue(yield* Deferred.isDone(committed));
          yield* Fiber.join(transaction);
          const mutation = yield* Effect.forkChild(
            sql`INSERT INTO recovery_transaction VALUES (3)`.pipe(
              Effect.andThen(Deferred.succeed(admitted, undefined)),
            ),
            { startImmediately: true },
          );
          yield* TestClock.adjust("0 millis");
          assert.isFalse(yield* Deferred.isDone(admitted));
          replacement.initialize();
          const snapshot = yield* Deferred.await(snapshotRequested);
          assert.isFalse(yield* Deferred.isDone(admitted));
          snapshot();
          yield* Fiber.join(mutation);
          assert.deepEqual(yield* sql`SELECT value FROM recovery_transaction ORDER BY value`, [
            { value: 1 },
            { value: 2 },
            { value: 3 },
          ]);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              workerStarts.onStart = undefined;
            }),
          ),
        );
      }),
    ),
);
