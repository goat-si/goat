import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";

import * as Reactivity from "effect/reactivity/Reactivity";
import * as Queue from "effect/Queue";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const config = workerRecovery.config;
      if (config !== undefined && typeof args[0] === "string") {
        // Inject at the native SQLite boundary in the real worker. Successful
        // attempts keep using its actual connection and prepared statements.
        args[0] =
          `(() => {
          const sqlite = require("node:sqlite");
          const config = ${JSON.stringify(config)};
          let attempts = 0;
          const prototype = config.point === "statement" ? sqlite.StatementSync.prototype : sqlite.DatabaseSync.prototype;
          const method = config.point === "statement" ? "all" : "prepare";
          const original = prototype[method];
          prototype[method] = function(...args) {
            const matches = config.point === "statement"
              ? this.sourceSQL.includes("recovery_value")
              : /^(PRAGMA journal_mode|SELECT sqlite_version\\(\\) AS version)$/.test(args[0]);
            if (matches) {
              const code = config.codes[attempts++] ?? (config.repeat ? config.codes.at(-1) : undefined);
              if (code !== undefined) throw Object.assign(new Error("injected SQLite failure " + code), { errcode: code });
            }
            return original.apply(this, args);
          };
        })();\n` + args[0];
      }
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
      if (config !== undefined) {
        this.on("message", (reply) => {
          const code = reply?.type === "unavailable" ? reply.errcode : reply?.error?.errcode;
          if (typeof code === "number") workerRecovery.onFailure?.(code);
        });
      }
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
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

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("records the writer connection owner on a waiting query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          sql`SELECT 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.withSpan("test.writerHolder"), Effect.forkChild);
      yield* Deferred.await(held);

      const waitingSpan = yield* Deferred.make<Tracer.Span>();
      const observeWaiter: Statement.Transformer = (statement, _sql, _fiber, span) =>
        Deferred.succeed(waitingSpan, span).pipe(Effect.as(statement));
      const waiter = yield* sql`SELECT 1`.pipe(
        Effect.provideService(Statement.CurrentTransformer, observeWaiter),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        (effect) => Effect.forkChild(effect, { startImmediately: true }),
      );
      const span = yield* Deferred.await(waitingSpan);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(waiter);

      assert.equal(span.attributes.get("db.lock_owner_at_start.name"), "test.writerHolder");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.fiber_id"), "number");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.trace_id"), "string");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.span_id"), "string");
    }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
});

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // Deferred BEGIN permits a competing commit, causing SQLITE_BUSY_SNAPSHOT that no timeout can resolve.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

// regression: #19226 read-only transactions run on the separate reader connection
it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      yield* (yield* FileSystem.FileSystem).remove(filename);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("finishes masked database cleanup after its caller is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cleanup_writes(value INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const work = yield* Effect.forkChild(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO cleanup_writes VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO cleanup_writes VALUES (2)`);
          }),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(work);
    assert.deepEqual(yield* sql`SELECT value FROM cleanup_writes ORDER BY value`.values, [
      [1],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

// oxlint-disable-next-line goat/no-real-time-wait-in-tests -- a zero-delay macrotask boundary that lets the worker's queued messages land, not a wait for time
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect.each([
  { reservation: false, masked: false },
  { reservation: false, masked: true },
  { reservation: true, masked: false },
  { reservation: true, masked: true },
])(
  "preserves caller cancellation while waiting (reservation=$reservation, masked=$masked)",
  ({ reservation, masked }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER)`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);
      const entered = yield* Deferred.make<void>();
      const body = sql`INSERT INTO entries VALUES (1)`.pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
      );
      const acquire = reservation
        ? Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* sql.reserve;
              yield* connection.executeUnprepared("INSERT INTO entries VALUES (1)", [], undefined);
              yield* Deferred.succeed(entered, undefined);
            }),
          )
        : sql.withTransaction(body);
      const waiter = yield* Effect.forkChild(masked ? Effect.uninterruptible(acquire) : acquire, {
        startImmediately: true,
      });
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(waiter), {
        startImmediately: true,
      });
      yield* Effect.gen(function* () {
        yield* eventLoopTurn;
        assert.equal(cancelled.pollUnsafe() !== undefined, !masked);
        assert.isFalse(yield* Deferred.isDone(entered));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
      yield* Fiber.join(cancelled);
      assert.equal(yield* Deferred.isDone(entered), masked);
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`);
      assert.deepEqual(
        yield* sql`SELECT value FROM entries ORDER BY value`.values,
        masked ? [[1], [2]] : [[2]],
      );
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const workerRecovery = vi.hoisted(() => ({
  config: undefined as
    | {
        point: "statement" | "initialize";
        codes: Array<number>;
        repeat?: boolean;
      }
    | undefined,
  onFailure: undefined as ((errcode: number) => void) | undefined,
}));

const recoveryBusy = () => Object.assign(new Error("database is locked"), { errcode: 261 });

const withWorkerRecovery = <A, E, R>(
  config: NonNullable<typeof workerRecovery.config>,
  use: (
    failures: Array<number>,
    attempted: (index?: number) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    const failures: Array<number> = [];
    const milestones = Array.from({ length: config.repeat ? 501 : config.codes.length }, () =>
      Deferred.makeUnsafe<void>(),
    );
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        workerRecovery.config = config;
        workerRecovery.onFailure = (code) => {
          const milestone = milestones[failures.length];
          failures.push(code);
          if (milestone !== undefined) Deferred.doneUnsafe(milestone, Effect.void);
        };
      }),
      () => use(failures, (index = 0) => Deferred.await(milestones[index]!)),
      () =>
        Effect.sync(() => {
          workerRecovery.config = undefined;
          workerRecovery.onFailure = undefined;
        }),
    );
  });
it.effect("waits for reader statement recovery with each request's result mode", () =>
  Effect.gen(function* () {
    const operations = [
      {
        run: (sql: SqlClient.SqlClient) => sql`SELECT 42 AS recovery_value`,
        expected: [{ recovery_value: 42 }],
      },
      {
        run: (sql: SqlClient.SqlClient) => sql`SELECT 42 AS recovery_value`.raw,
        expected: [{ recovery_value: 42 }],
      },
      {
        run: (sql: SqlClient.SqlClient) => sql`SELECT 42 AS recovery_value`.values,
        expected: [[42]],
      },
      {
        run: (sql: SqlClient.SqlClient) => sql`SELECT 42 AS recovery_value`.valuesUnprepared,
        expected: [[42]],
      },
      {
        run: (sql: SqlClient.SqlClient) => sql`SELECT 42 AS recovery_value`.unprepared,
        expected: [{ recovery_value: 42 }],
      },
    ];
    for (const operation of operations) {
      yield* withWorkerRecovery({ point: "statement", codes: [261] }, (failures, attempted) =>
        withReaderClient((sql) =>
          Effect.gen(function* () {
            const fiber = yield* operation.run(sql).pipe(SqliteClient.readOnly, Effect.forkChild);
            yield* attempted();
            yield* TestClock.adjust("10 millis");
            assert.deepEqual(yield* Fiber.join(fiber), operation.expected);
            assert.deepEqual(failures, [261]);
            assert.deepEqual(yield* sql`SELECT 42 AS recovery_value`.pipe(SqliteClient.readOnly), [
              { recovery_value: 42 },
            ]);
          }),
        ),
      );
    }
  }),
);

it.effect("serializes a reader's recovery wait against another transaction and result mode", () =>
  withWorkerRecovery({ point: "statement", codes: [261] }, (_, attempted) =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const select = sql`SELECT 42 AS recovery_value`;
        const entered = yield* Deferred.make<void>();
        const values = yield* select.values.pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* attempted();
        const transaction = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* select;
            }),
          )
          .pipe(SqliteClient.readOnly, Effect.forkChild({ startImmediately: true }));
        assert.equal(yield* Deferred.isDone(entered), false);
        yield* TestClock.adjust("10 millis");
        assert.deepEqual(yield* Fiber.join(values), [[42]]);
        assert.deepEqual(yield* Fiber.join(transaction), [{ recovery_value: 42 }]);
      }),
    ),
  ),
);

it.effect("bounds reader recovery retries and preserves the final lock error", () =>
  withWorkerRecovery({ point: "statement", codes: [261], repeat: true }, (failures, attempted) =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const fiber = yield* sql`SELECT 42 AS recovery_value`.pipe(
          SqliteClient.readOnly,
          Effect.flip,
          Effect.forkChild,
        );
        for (let i = 0; i < 500; i++) {
          yield* attempted(i);
          yield* TestClock.adjust("10 millis");
        }
        const error = yield* Fiber.join(fiber);
        assert.lengthOf(failures, 501);
        assert.equal(error.reason._tag, "LockTimeoutError");
        assert.propertyVal(error.reason.cause, "errcode", 261);
        assert.propertyVal(error.reason.cause, "message", "injected SQLite failure 261");
        // A statement failure does not permanently disable the reader.
        const readonlyError = yield* sql`INSERT INTO entries VALUES ('forbidden')`.pipe(
          SqliteClient.readOnly,
          Effect.flip,
        );
        assert.propertyVal(readonlyError.reason.cause, "errcode", 8);
      }),
    ),
  ),
);

it.effect("keeps the reader snapshot and never replays the transaction body during recovery", () =>
  withWorkerRecovery({ point: "statement", codes: [261] }, (_, attempted) =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        let bodies = 0;
        const reader = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              bodies++;
              assert.equal(yield* countEntries(sql), 1);
              return yield* sql`SELECT COUNT(*) AS recovery_value FROM entries`;
            }),
          )
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* attempted();
        yield* sql`INSERT INTO entries VALUES ('committed during recovery')`;
        yield* TestClock.adjust("10 millis");
        assert.deepEqual(yield* Fiber.join(reader), [{ recovery_value: 1 }]);
        assert.equal(bodies, 1);
        assert.equal(yield* countEntries(sql), 2);
      }),
    ),
  ),
);

it.effect("stops reader recovery retry on a changed error and never retries other codes", () =>
  Effect.gen(function* () {
    for (const codes of [[261, 517], [5], [517], [6], [19]]) {
      yield* withWorkerRecovery(
        { point: "statement", codes, repeat: true },
        (failures, attempted) =>
          withReaderClient((sql) =>
            Effect.gen(function* () {
              const fiber = yield* sql`SELECT 42 AS recovery_value`.pipe(
                SqliteClient.readOnly,
                Effect.flip,
                Effect.forkChild,
              );
              yield* attempted();
              if (codes.length === 2) yield* TestClock.adjust("10 millis");
              const error = yield* Fiber.join(fiber);
              assert.deepEqual(failures, codes);
              assert.propertyVal(error.reason.cause, "errcode", codes.at(-1));
            }),
          ),
      );
    }
  }),
);

it.effect("releases reader requests and connection permits when recovery is interrupted", () =>
  withWorkerRecovery({ point: "statement", codes: [261] }, (_, attempted) =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const select = sql`SELECT 42 AS recovery_value`;
        const values = yield* sql
          .withTransaction(select.values)
          .pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* attempted();
        const waiter = yield* select.pipe(
          SqliteClient.readOnly,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(waiter);
        yield* Fiber.interrupt(values);
        assert.deepEqual(yield* select.pipe(SqliteClient.readOnly), [{ recovery_value: 42 }]);
        assert.deepEqual(yield* sql.withTransaction(select).pipe(SqliteClient.readOnly), [
          { recovery_value: 42 },
        ]);
      }),
    ),
  ),
);

it.effect("keeps concurrent reader acquires on one startup through WAL recovery", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withWorkerRecovery({ point: "initialize", codes: [261] }, (failures, attempted) =>
    withReaderClient((sql) =>
      Effect.gen(function* () {
        const before = startedWorkers.length;
        const first = yield* countEntries(sql).pipe(SqliteClient.readOnly, Effect.forkChild);
        yield* attempted();
        const second = yield* countEntries(sql).pipe(
          SqliteClient.readOnly,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("10 millis");
        assert.equal(yield* Fiber.join(first), 1);
        assert.equal(yield* Fiber.join(second), 1);
        assert.deepEqual(failures, [261]);
        assert.equal(startedWorkers.length, before + 1);
        const error = yield* sql`INSERT INTO entries VALUES ('forbidden')`.pipe(
          SqliteClient.readOnly,
          Effect.flip,
        );
        assert.propertyVal(error.reason.cause, "errcode", 8);
        assert.lengthOf(warnings, 0);
      }),
    ),
  ).pipe(Effect.provide(logs));
});

it.effect("falls back to the writer only after reader startup recovery is exhausted", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withWorkerRecovery(
    { point: "initialize", codes: [261], repeat: true },
    (failures, attempted) =>
      withReaderClient((sql) =>
        Effect.gen(function* () {
          const first = yield* countEntries(sql).pipe(SqliteClient.readOnly, Effect.forkChild);
          for (let i = 0; i < 500; i++) {
            yield* attempted(i);
            yield* TestClock.adjust("10 millis");
          }
          assert.equal(yield* Fiber.join(first), 1);
          assert.lengthOf(failures, 501);
          assert.lengthOf(warnings, 1);
          const before = startedWorkers.length;
          yield* sql`INSERT INTO entries VALUES ('fallback')`.pipe(SqliteClient.readOnly);
          assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
          assert.equal(startedWorkers.length, before);
        }),
      ),
  ).pipe(Effect.provide(logs));
});

it.effect("waits for WAL recovery when executing writer statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE recovery_entries(value INTEGER)`;
    const operations = [
      () => sql`INSERT INTO recovery_entries VALUES (1) RETURNING value`,
      () => sql`SELECT value FROM recovery_entries`.values,
      () => sql`SELECT value FROM recovery_entries`.valuesUnprepared,
      () => sql`SELECT value FROM recovery_entries`.unprepared,
    ];
    for (const operation of operations) {
      const attempted = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementationOnce(() => {
            Deferred.doneUnsafe(attempted, Effect.void);
            throw recoveryBusy();
          }),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* operation().pipe(Effect.forkChild);
            yield* Deferred.await(attempted);
            yield* TestClock.adjust("10 millis");
            yield* Fiber.join(fiber);
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
    const writes = [
      () => sql`INSERT INTO recovery_entries VALUES (2)`,
      () => sql`INSERT INTO recovery_entries VALUES (2)`.raw,
      () => sql`INSERT INTO recovery_entries VALUES (2)`.values,
      () => sql`INSERT INTO recovery_entries VALUES (2)`.valuesUnprepared,
    ];
    for (const write of writes) {
      const attempted = yield* Deferred.make<void>();
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "run").mockImplementationOnce(() => {
            Deferred.doneUnsafe(attempted, Effect.void);
            throw recoveryBusy();
          }),
        ),
        () =>
          Effect.gen(function* () {
            const fiber = yield* write().pipe(Effect.forkChild);
            yield* Deferred.await(attempted);
            yield* TestClock.adjust("10 millis");
            yield* Fiber.join(fiber);
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
    assert.deepEqual(yield* sql`SELECT value FROM recovery_entries`.values, [
      [1],
      [2],
      [2],
      [2],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("isolates a writer waiting for WAL recovery from another transaction's rollback", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE isolated_recovery(value TEXT)`;
    const insert = sql`INSERT INTO isolated_recovery VALUES ('survives')`;
    // Exercise a cached statement, rather than serializing on a pending prepare.
    yield* insert;
    yield* sql`DELETE FROM isolated_recovery`;
    const attempted = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const rollback = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "run").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const writer = yield* insert.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          // Run B until it blocks on the permit (or, on the broken client,
          // enters its transaction and blocks on the rollback barrier).
          const transaction = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(rollback);
                return yield* Effect.fail("rollback B");
              }),
            )
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          const enteredDuringRecovery = yield* Deferred.isDone(entered);
          yield* TestClock.adjust("10 millis");
          yield* Fiber.join(writer);
          yield* Deferred.await(entered);
          yield* Deferred.succeed(rollback, undefined);
          assert.equal(yield* Fiber.join(transaction), "rollback B");
          // A must survive B's rollback even though A resumed on the same DB.
          assert.deepEqual(yield* sql`SELECT value FROM isolated_recovery`, [
            { value: "survives" },
          ]);
          assert.equal(enteredDuringRecovery, false);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("isolates values waiting for WAL recovery from the same cached object query", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = sql<{ value: number }>`SELECT 42 AS value`;
    yield* select;
    const attempted = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const values = yield* select.values.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          const objects = yield* select.pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust("10 millis");
          assert.deepEqual(yield* Fiber.join(values), [[42]]);
          assert.deepEqual(yield* Fiber.join(objects), [{ value: 42 }]);
          assert.deepEqual(yield* select, [{ value: 42 }]);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("releases statement permits and result mode after interrupted WAL recovery", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = sql<{ value: number }>`SELECT 42 AS value`;
    yield* select;
    const attempted = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const values = yield* select.values.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          const waiter = yield* select.pipe(Effect.forkChild({ startImmediately: true }));
          yield* Fiber.interrupt(waiter);
          yield* Fiber.interrupt(values);
          assert.deepEqual(yield* select, [{ value: 42 }]);
          assert.deepEqual(yield* sql.withTransaction(select), [{ value: 42 }]);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("releases connections across statement scope consumers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const select = sql<{ value: number }>`SELECT 42 AS value`;
    // reserve owns its caller's scope; execute through the returned connection.
    const reserved = yield* Effect.scoped(
      Effect.flatMap(sql.reserve, (connection) =>
        connection.execute("SELECT 42 AS value", [], undefined),
      ),
    );
    assert.deepEqual(reserved, [{ value: 42 }]);
    assert.deepEqual(yield* select, reserved);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const results = yield* sql.reactiveMailbox(["statement-scope"], select);
        assert.deepEqual(yield* Queue.take(results), [{ value: 42 }]);
        // A reactive query must release before its subscription scope closes.
        assert.deepEqual(yield* select, [{ value: 42 }]);
        yield* Reactivity.invalidate(["statement-scope"]);
        assert.deepEqual(yield* Queue.take(results), [{ value: 42 }]);
      }),
    );

    const streamed = yield* select.stream.pipe(Stream.runCollect, Effect.exit);
    assert(Exit.isFailure(streamed));
    // Unsupported streams still close their acquisition scope on failure.
    assert.deepEqual(yield* select, [{ value: 42 }]);
    assert.deepEqual(yield* sql.withTransaction(sql.withTransaction(select)), [{ value: 42 }]);
  }).pipe(
    Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), Reactivity.layer)),
  ),
);

it.effect("waits for WAL recovery when preparing a writer statement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempted = yield* Deferred.make<void>();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementationOnce(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          throw recoveryBusy();
        }),
      ),
      () =>
        Effect.gen(function* () {
          const fiber = yield* sql`SELECT 42 AS value`.pipe(Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("10 millis");
          assert.deepEqual(yield* Fiber.join(fiber), [{ value: 42 }]);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("bounds WAL recovery retries and preserves the lock failure", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempted = yield* Deferred.make<void>();
    let lastFailure = recoveryBusy();
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(() => {
          Deferred.doneUnsafe(attempted, Effect.void);
          lastFailure = recoveryBusy();
          throw lastFailure;
        }),
      ),
      (spy) =>
        Effect.gen(function* () {
          const fiber = yield* sql`SELECT 1`.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("5 seconds");
          const error = yield* Fiber.join(fiber);
          assert.equal(error.reason._tag, "LockTimeoutError");
          assert.equal(spy.mock.calls.length, 501);
          assert.strictEqual(error.reason.cause, lastFailure);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("stops WAL recovery retries when the SQLite error changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const attempted = yield* Deferred.make<void>();
    const snapshotFailure = Object.assign(new Error("stale snapshot"), { errcode: 517 });
    yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        vi
          .spyOn(NodeSqlite.StatementSync.prototype, "all")
          .mockImplementationOnce(() => {
            Deferred.doneUnsafe(attempted, Effect.void);
            throw recoveryBusy();
          })
          .mockImplementation(() => {
            throw snapshotFailure;
          }),
      ),
      (spy) =>
        Effect.gen(function* () {
          const fiber = yield* sql`SELECT 1`.pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(attempted);
          yield* TestClock.adjust("10 millis");
          const error = yield* Fiber.join(fiber);
          assert.equal(spy.mock.calls.length, 2);
          assert.strictEqual(error.reason.cause, snapshotFailure);
        }),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("does not retry a stale WAL snapshot or unrelated SQLite errors", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const errcode of [5, 517, 6, 19]) {
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(() => {
            throw Object.assign(new Error("sqlite failure"), { errcode });
          }),
        ),
        (spy) =>
          Effect.gen(function* () {
            yield* sql`SELECT 1`.pipe(Effect.flip);
            assert.equal(spy.mock.calls.length, 1);
          }),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("serializes reader requests through their replies without leaking values mode", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      // Finish startup before holding requests at the worker transport boundary.
      yield* countEntries(sql).pipe(SqliteClient.readOnly);
      const worker = startedWorkers[startedWorkers.length - 1]!;
      const send = worker.postMessage.bind(worker);
      const requests: Array<() => void> = [];
      const postMessage = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
        requests.push(() => send(...args));
      });
      yield* Effect.gen(function* () {
        const select = sql`SELECT name FROM entries`;
        const values = yield* Effect.forkChild(select.values.pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        const objects = yield* Effect.forkChild(select.pipe(SqliteClient.readOnly), {
          startImmediately: true,
        });
        // A pending reply holds the connection so a retry cannot be overtaken
        // by another request or a transaction on the same worker.
        assert.lengthOf(requests, 1);
        postMessage.mockRestore();
        for (const request of requests) request();
        assert.deepEqual(yield* Fiber.join(values), [["first"]]);
        assert.deepEqual(yield* Fiber.join(objects), [{ name: "first" }]);
        assert.deepEqual(yield* select.pipe(SqliteClient.readOnly), [{ name: "first" }]);
      }).pipe(Effect.ensuring(Effect.sync(() => postMessage.mockRestore())));
    }),
  ),
);

it.effect("recovers checkpoint worker startup before handing checkpoints off", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withWorkerRecovery({ point: "initialize", codes: [261] }, (failures, attempted) =>
    Effect.gen(function* () {
      const client = yield* withCheckpointClient((sql) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          // A barrier can initialize the worker before the startup retry does.
          // Wait for the retry's acknowledgement before asking it to checkpoint.
          yield* Effect.callback<void>((resume) => {
            const onReady = (reply: unknown) => {
              if (
                typeof reply === "object" &&
                reply !== null &&
                "type" in reply &&
                reply.type === "ready"
              ) {
                resume(Effect.void);
              }
            };
            worker.on("message", onReady);
            return Effect.sync(() => worker.off("message", onReady));
          });
          yield* checkpointWorkerReply(worker);
          const rows = yield* sql`PRAGMA wal_autocheckpoint`;
          assert.equal(rows[0]?.wal_autocheckpoint, 0);
        }),
      ).pipe(Effect.forkChild);
      yield* attempted();
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(client);
      assert.deepEqual(failures, [261]);
      assert.lengthOf(warnings, 0);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("hands checkpoints back after worker startup recovery is exhausted", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withWorkerRecovery(
    { point: "initialize", codes: [261], repeat: true },
    (failures, attempted) =>
      Effect.gen(function* () {
        const client = yield* withCheckpointClient((sql) =>
          Effect.gen(function* () {
            const worker = startedWorkers.at(-1)!;
            if (worker.threadId !== -1) {
              yield* Effect.promise(() => new Promise((resolve) => worker.once("exit", resolve)));
            }
            const rows = yield* sql`PRAGMA wal_autocheckpoint`;
            assert.equal(rows[0]?.wal_autocheckpoint, 1000);
          }),
        ).pipe(Effect.forkChild);
        for (let i = 0; i < 500; i++) {
          yield* attempted(i);
          yield* TestClock.adjust("10 millis");
        }
        yield* Fiber.join(client);
        assert.lengthOf(failures, 501);
        assert.lengthOf(warnings, 1);
      }),
  ).pipe(Effect.provide(logs));
});

it.effect("stops worker startup recovery when the error changes", () =>
  Effect.gen(function* () {
    for (const checkpoint of [false, true]) {
      yield* withWorkerRecovery(
        { point: "initialize", codes: [261, 517], repeat: true },
        (failures, attempted) =>
          Effect.gen(function* () {
            const use = (sql: SqlClient.SqlClient) =>
              Effect.gen(function* () {
                // Reader fallback is writable; checkpoint fallback restores SQLite's default.
                if (checkpoint) {
                  const worker = startedWorkers.at(-1)!;
                  if (worker.threadId !== -1) {
                    yield* Effect.promise(
                      () => new Promise((resolve) => worker.once("exit", resolve)),
                    );
                  }
                  const rows = yield* sql`PRAGMA wal_autocheckpoint`;
                  assert.equal(rows[0]?.wal_autocheckpoint, 1000);
                } else {
                  yield* sql`INSERT INTO entries VALUES ('fallback')`.pipe(SqliteClient.readOnly);
                }
              });
            const client = yield* (
              checkpoint ? withCheckpointClient(use) : withReaderClient(use)
            ).pipe(Effect.forkChild);
            yield* attempted();
            yield* TestClock.adjust("10 millis");
            yield* Fiber.join(client);
            assert.deepEqual(failures, [261, 517]);
          }),
      );
    }
  }).pipe(Effect.provide(Logger.layer([Logger.make(() => {})]))),
);

it.effect("closes workers when their startup recovery scope is interrupted", () =>
  Effect.gen(function* () {
    for (const checkpoint of [false, true]) {
      yield* withWorkerRecovery(
        { point: "initialize", codes: [261], repeat: true },
        (_, attempted) =>
          Effect.gen(function* () {
            const client = yield* (
              checkpoint
                ? withCheckpointClient(() => Effect.never)
                : withReaderClient((sql) => countEntries(sql).pipe(SqliteClient.readOnly))
            ).pipe(Effect.forkChild);
            yield* attempted();
            const worker = startedWorkers.at(-1)!;
            yield* Fiber.interrupt(client);
            assert.equal(worker.threadId, -1);
          }),
      );
    }
  }),
);

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

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
