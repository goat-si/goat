import { it } from "@effect/vitest";
import { assert, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));
const workerStarts = vi.hoisted(() => ({
  onStart: undefined as ((worker: NodeWorkerThreads.Worker) => void) | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (failingWorkers.message !== undefined) {
        args = [`throw new Error(${JSON.stringify(failingWorkers.message)})`, { eval: true }];
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
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-restart-" });
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

const nextStartedWorker = Effect.callback<NodeWorkerThreads.Worker>((resume) => {
  workerStarts.onStart = (worker) => resume(Effect.succeed(worker));
  return Effect.sync(() => {
    workerStarts.onStart = undefined;
  });
});

// Fails slot 0's first startup so the pool is in restart backoff (deadline 250ms), then lets workers start again.
const failFirstStartup = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    failingWorkers.message = "startup fault";
    yield* countEntries(sql).pipe(SqliteClient.readOnly, Effect.flip);
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        failingWorkers.message = undefined;
      }),
    ),
  );

// Restarts slot 0 at the deadline and holds its startup reply at the worker boundary.
const holdRestart = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const created = yield* Effect.forkChild(nextStartedWorker, { startImmediately: true });
    const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
      startImmediately: true,
    });
    yield* TestClock.adjust("250 millis");
    const worker = yield* Fiber.join(created);
    const held = yield* Deferred.make<void>();
    const emit = worker.emit.bind(worker);
    const spy = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
      if (event !== "message") return emit(event, ...args);
      Deferred.doneUnsafe(held, Effect.void);
      return true;
    });
    yield* Deferred.await(held);
    const release = Effect.sync(() => {
      spy.mockRestore();
      worker.emit("message", { type: "ready" });
    });
    return { read, release };
  });

it.effect("a restart in progress holds back a slot that arrives after the deadline", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* failFirstStartup(sql);
      const restart = yield* holdRestart(sql);
      const before = startedWorkers.length;
      const late = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
        startImmediately: true,
      });
      yield* TestClock.adjust("0 millis");
      // The deadline has passed, but slot 0's restart still holds the gate.
      assert.equal(startedWorkers.length, before);
      yield* restart.release;
      assert.equal(yield* Fiber.join(restart.read), 1);
      assert.equal(yield* Fiber.join(late), 1);
    }),
  ),
);

it.effect("a cancelled restart request still holds back the next restart until startup ends", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      yield* failFirstStartup(sql);
      const restart = yield* holdRestart(sql);
      const before = startedWorkers.length;
      // Slot 0 is leased by the restart, so this read waits at the gate on slot 1.
      const next = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
        startImmediately: true,
      });
      yield* TestClock.adjust("0 millis");
      yield* Fiber.interrupt(restart.read);
      yield* TestClock.adjust("0 millis");
      // The interrupted request released the gate; the next one waits for slot 0's startup instead.
      assert.equal(startedWorkers.length, before);
      yield* restart.release;
      assert.equal(yield* Fiber.join(next), 1);
    }),
  ),
);

it.effect("serves reads from a running slot while another slot waits out restart backoff", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      const release = yield* Deferred.make<void>();
      const entered = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
      const held = [];
      for (const started of entered)
        held.push(
          yield* Effect.forkChild(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* countEntries(sql);
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }),
              )
              .pipe(SqliteClient.readOnly),
            { startImmediately: true },
          ),
        );
      for (const started of entered) yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      for (const fiber of held) yield* Fiber.join(fiber);
      assert.equal(startedWorkers.length, before + 2);
      // The first slot's worker dies, so that slot must wait out restart backoff.
      yield* Effect.promise(() => startedWorkers[before]!.terminate());
      // The clock never advances: only the still-running slot can serve this read.
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, before + 2);
    }),
  ),
);

it.effect("slots waiting on one restart deadline start one worker at a time", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      failingWorkers.message = "startup fault";
      yield* Effect.gen(function* () {
        yield* countEntries(sql).pipe(SqliteClient.readOnly, Effect.flip);
        const before = startedWorkers.length;
        const reads = [];
        for (let index = 0; index < 2; index++)
          reads.push(
            yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly, Effect.result), {
              startImmediately: true,
            }),
          );
        yield* TestClock.adjust("249 millis");
        assert.equal(startedWorkers.length, before);
        yield* TestClock.adjust("1 millis");
        // The first restart fails and moves the deadline to 750ms; the second slot keeps waiting.
        assert.equal(startedWorkers.length, before + 1);
        assert.equal((yield* Fiber.join(reads[0]!))._tag, "Failure");
        yield* TestClock.adjust("499 millis");
        assert.equal(startedWorkers.length, before + 1);
        yield* TestClock.adjust("1 millis");
        assert.equal(startedWorkers.length, before + 2);
        assert.equal((yield* Fiber.join(reads[1]!))._tag, "Failure");
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

it.effect("a slot waiting out restart backoff honors a deadline another slot extends", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const before = startedWorkers.length;
      const releases = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
      const entered = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()];
      const held = [];
      for (const [index, release] of releases.entries())
        held.push(
          yield* Effect.forkChild(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* countEntries(sql);
                  yield* Deferred.succeed(entered[index]!, undefined);
                  yield* Deferred.await(release);
                }),
              )
              .pipe(SqliteClient.readOnly, Effect.exit),
            { startImmediately: true },
          ),
        );
      for (const started of entered) yield* Deferred.await(started);
      yield* Deferred.succeed(releases[0]!, undefined);
      yield* Fiber.join(held[0]!);
      // Slot 0's worker dies: the shared deadline becomes 250ms and slot 1 stays busy.
      yield* Effect.promise(() => startedWorkers[before]!.terminate());
      const read = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
        startImmediately: true,
      });
      yield* TestClock.adjust("100 millis");
      // Slot 1's worker dies too, pushing the shared deadline to 600ms.
      yield* Effect.promise(() => startedWorkers[before + 1]!.terminate());
      yield* TestClock.adjust("150 millis");
      assert.equal(startedWorkers.length, before + 2);
      yield* TestClock.adjust("350 millis");
      assert.equal(yield* Fiber.join(read), 1);
      assert.equal(startedWorkers.length, before + 3);
      yield* Deferred.succeed(releases[1]!, undefined);
      yield* Fiber.join(held[1]!);
    }),
  ),
);

it.effect(
  "a restart whose worker never answers holds back the next one only until the startup deadline",
  () =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        yield* failFirstStartup(sql);
        const restart = yield* holdRestart(sql);
        const before = startedWorkers.length;
        const next = yield* Effect.forkChild(countEntries(sql).pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        yield* TestClock.adjust("0 millis");
        yield* Fiber.interrupt(restart.read);
        yield* TestClock.adjust("9999 millis");
        assert.equal(startedWorkers.length, before);
        // Slot 0's worker never answered; at the 10s startup deadline the next slot restarts anyway.
        yield* TestClock.adjust("1 millis");
        assert.equal(startedWorkers.length, before + 1);
        assert.equal(yield* Fiber.join(next), 1);
        yield* restart.release;
      }),
    ),
);
