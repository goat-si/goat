import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { makeWriter } from "./nodeSqliteWriter.ts";
import * as Exit from "effect/Exit";
import { recentSlowSql } from "./slowSqlOperations.ts";
import * as Result from "effect/Result";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";
import * as SqliteClient from "./nodeSqliteClient.ts";
import { writerWorkerSource } from "./sqliteWriterWorkerSource.ts";
import {
  recoveryPrelude,
  observeFailures,
  initialCheckpointPrelude,
  holdInitialCheckpoint,
  awaitWorkerExit,
  maintenancePrelude,
  holdMaintenance,
  captureWriterNotices,
  gateAdmissionRetries,
  awaitAdmissionRecovery,
} from "./nodeSqliteWriter.testFixtures.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const nativeFixture = vi.hoisted(() => ({
  prelude: "",
  onStart: undefined as ((worker: NodeWorkerThreads.Worker) => void) | undefined,
}));
const setup = () => {
  startedWorkers.length = 0;
  nativeFixture.prelude = "";
  nativeFixture.onStart = undefined;
};
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (typeof args[0] === "string") args[0] = nativeFixture.prelude + args[0];
      super(...args);
      startedWorkers.push(this);
      nativeFixture.onStart?.(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("keeps transaction ownership through ordered worker statements and rollback", () =>
  Effect.gen(function* () {
    setup();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-owner-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE owner_probe(value TEXT)`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* Effect.forkChild(
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO owner_probe VALUES ('rolled-back')`;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* Effect.fail("rollback");
            }),
          )
          .pipe(Effect.result),
      );
      yield* Deferred.await(entered);
      const competing = yield* Effect.forkChild(sql`INSERT INTO owner_probe VALUES ('outside')`, {
        startImmediately: true,
      });
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Result.isFailure(yield* Fiber.join(transaction)));
      yield* Fiber.join(competing);
      assert.deepEqual(yield* sql`SELECT value FROM owner_probe`, [{ value: "outside" }]);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: path.join(directory, "state.sqlite"), writerWorker: true }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const withWriterClient = <A, E>(
  use: (sql: SqlClient.SqlClient, filename: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
  options: Partial<SqliteClient.SqliteClientConfig> = {},
  prelude = "",
) =>
  Effect.gen(function* () {
    setup();
    nativeFixture.prelude = prelude;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-contract-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "preserves raw results values safe integers and NUL text across the writer boundary",
  () =>
    withWriterClient((sql) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE writer_modes(value TEXT)`;
        const raw = yield* sql`INSERT INTO writer_modes VALUES ('one')`.raw;
        assert.deepEqual(raw, { lastInsertRowid: 1, changes: 1 });
        const text = "left\0right";
        const select = sql`SELECT ${text} AS text, 42 AS id`;
        assert.deepEqual(yield* select, [{ text, id: 42 }]);
        assert.deepEqual(
          yield* select.values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)),
          [[text, 42n]],
        );
        assert.deepEqual(yield* select.valuesUnprepared, [[text, 42]]);
        assert.deepEqual(yield* select, [{ text, id: 42 }]);
      }),
    ),
);

it.effect("never replays a writer mutation after its committed reply is lost", () =>
  withWriterClient(
    (sql, filename) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE uncertain_probe(value INTEGER)`;
        const worker = startedWorkers[0]!;
        yield* sql`SELECT 1`.pipe(SqliteClient.readOnly);
        const replied = yield* Deferred.make<void>();
        let heldId: number | undefined;
        const post = worker.postMessage.bind(worker);
        using _sending = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
          if (
            typeof message === "object" &&
            message !== null &&
            "sql" in message &&
            typeof message.sql === "string" &&
            message.sql.includes("INSERT INTO uncertain_probe") &&
            "id" in message &&
            typeof message.id === "number"
          )
            heldId = message.id;
          post(message, ...rest);
        });
        const emit = worker.emit.bind(worker);
        using _losing = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
          const reply: unknown = args[0];
          if (
            event === "message" &&
            typeof reply === "object" &&
            reply !== null &&
            "id" in reply &&
            reply.id === heldId &&
            "rows" in reply
          ) {
            Deferred.doneUnsafe(replied, Effect.void);
            return true;
          }
          return emit(event, ...args);
        });
        const insert = yield* Effect.forkChild(
          sql`INSERT INTO uncertain_probe VALUES (1)`.pipe(Effect.flip),
        );
        yield* Deferred.await(replied);
        yield* Effect.promise(() => worker.terminate());
        assert.equal((yield* Fiber.join(insert))._tag, "SqlError");
        assert.equal(
          (yield* sql`SELECT value FROM uncertain_probe`.pipe(Effect.flip))._tag,
          "SqlError",
        );
        assert.equal(
          (yield* sql`SELECT 1`.pipe(SqliteClient.readOnly, Effect.flip))._tag,
          "SqlError",
        );
        const independent = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
        try {
          assert.equal(
            independent.prepare("SELECT COUNT(*) AS count FROM uncertain_probe").get()?.count,
            1,
          );
        } finally {
          independent.close();
        }
      }),
    { readerWorker: true },
  ),
);

it.effect(
  "commits once after a nested rollback and keeps readOnly inside the writer transaction",
  () =>
    withWriterClient(
      (sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE TABLE savepoint_probe(value TEXT)`;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const transaction = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO savepoint_probe VALUES ('outer')`;
                const nested = yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sql`INSERT INTO savepoint_probe VALUES ('inner')`;
                      return yield* Effect.fail("rollback savepoint");
                    }),
                  )
                  .pipe(Effect.result);
                assert.isTrue(Result.isFailure(nested));
                assert.deepEqual(
                  yield* sql`SELECT value FROM savepoint_probe`.pipe(SqliteClient.readOnly),
                  [{ value: "outer" }],
                );
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          assert.deepEqual(
            yield* sql`SELECT value FROM savepoint_probe`.pipe(SqliteClient.readOnly),
            [],
          );
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(transaction);
          assert.deepEqual(
            yield* sql`SELECT value FROM savepoint_probe`.pipe(SqliteClient.readOnly),
            [{ value: "outer" }],
          );
          assert.equal(startedWorkers.length, 2);
        }),
      { readerWorker: true, checkpointWorker: true },
    ),
);

it.effect("preserves named callable blob and transformed binding contracts", () =>
  withWriterClient(
    (sql) =>
      Effect.gen(function* () {
        const buffer = new Uint8Array([0, 1, 255]).buffer;
        const shared = new SharedArrayBuffer(3);
        new Uint8Array(shared).set([2, 0, 3]);
        for (const value of [buffer, shared, new Uint8Array([4, 0, 5])]) {
          const expected = Array.from(
            new Uint8Array(ArrayBuffer.isView(value) ? value.buffer : value),
          );
          assert.deepEqual(yield* sql.unsafe("SELECT ? AS blob", [value]).values, [
            [new Uint8Array(expected)],
          ]);
          assert.deepEqual(yield* sql.unsafe("SELECT $blob AS blob", [{ $blob: value }]).values, [
            [new Uint8Array(expected)],
          ]);
          const callable = Object.assign(() => {}, { $blob: value });
          assert.deepEqual(yield* sql.unsafe("SELECT $blob AS blob", [callable]).valuesUnprepared, [
            [new Uint8Array(expected)],
          ]);
        }
        assert.deepEqual(yield* sql`SELECT 1 AS snake_name`, [{ snakeName: 1 }]);
        yield* sql`CREATE TABLE transformed_probe(snake_name TEXT)`;
        yield* sql`INSERT INTO transformed_probe ${sql.insert({ snakeName: "kept" })}`;
        assert.deepEqual(yield* sql`SELECT snake_name FROM transformed_probe`.unprepared, [
          { snakeName: "kept" },
        ]);
        const cloneError = yield* sql.unsafe("SELECT ?", [Symbol("uncloneable")]).pipe(Effect.flip);
        assert.equal(cloneError._tag, "SqlError");
        assert.deepEqual(yield* sql`SELECT 1 AS ok`, [{ ok: 1 }]);
      }),
    {
      transformQueryNames: (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      transformResultNames: (name) =>
        name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    },
  ),
);

// Hold an actual native completion; the transaction still owns the outstanding request.
const holdReply = (worker: NodeWorkerThreads.Worker, matches: string) => {
  const arrived = Deferred.makeUnsafe<void>();
  let id: number | undefined;
  let release = () => {};
  const post = worker.postMessage.bind(worker);
  const sending = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
    if (typeof message?.sql === "string" && message.sql.includes(matches)) id = message.id;
    post(message, ...rest);
  });
  const emit = worker.emit.bind(worker);
  const holding = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
    const reply: unknown = args[0];
    if (
      event === "message" &&
      typeof reply === "object" &&
      reply !== null &&
      "id" in reply &&
      reply.id === id &&
      "rows" in reply
    ) {
      release = () => {
        emit(event, ...args);
      };
      Deferred.doneUnsafe(arrived, Effect.void);
      return true;
    }
    return emit(event, ...args);
  });
  return {
    arrived,
    release: () => {
      release();
      release = () => {};
    },
    [Symbol.dispose]() {
      release();
      sending.mockRestore();
      holding.mockRestore();
    },
  };
};

it.effect("waits for an interrupted statement before rollback and the outside borrower", () =>
  withWriterClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE interrupt_probe(value TEXT)`;
      const worker = startedWorkers.at(-1)!;
      using held = holdReply(worker, "INSERT INTO interrupt_probe VALUES ('cancelled')");
      const transaction = yield* sql
        .withTransaction(sql`INSERT INTO interrupt_probe VALUES ('cancelled')`)
        .pipe(Effect.forkChild);
      yield* Deferred.await(held.arrived);
      const cancelled = yield* Fiber.interrupt(transaction).pipe((effect) =>
        Effect.forkChild(effect, { startImmediately: true }),
      );
      const outside = yield* sql`INSERT INTO interrupt_probe VALUES ('outside')`.pipe((effect) =>
        Effect.forkChild(effect, { startImmediately: true }),
      );
      assert.isUndefined(cancelled.pollUnsafe());
      assert.isUndefined(outside.pollUnsafe());
      // A control task can run on the parent while the native reply is held.
      const control = yield* Effect.succeed("responsive").pipe(Effect.forkChild);
      assert.equal(yield* Fiber.join(control), "responsive");
      held.release();
      yield* Fiber.join(cancelled);
      yield* Fiber.join(outside);
      assert.deepEqual(yield* sql`SELECT value FROM interrupt_probe`, [{ value: "outside" }]);
    }),
  ),
);

it.effect.each(["prepare", "execute"] as const)(
  "retries only WAL recovery at writer %s without losing values mode",
  (point) =>
    withWriterClient(
      (sql) =>
        Effect.gen(function* () {
          using failures = observeFailures(startedWorkers.at(-1)!, 1);
          const waiting = yield* sql`SELECT 42 AS recovery_value`.values.pipe(
            Effect.provideService(SqlClient.SafeIntegers, true),
            Effect.forkChild,
          );
          yield* Deferred.await(failures.milestones[0]!);
          const outside = yield* sql`SELECT 43 AS recovery_value`.pipe((effect) =>
            Effect.forkChild(effect, { startImmediately: true }),
          );
          assert.isUndefined(outside.pollUnsafe());
          yield* TestClock.adjust("10 millis");
          assert.deepEqual(yield* Fiber.join(waiting), [[42n]]);
          assert.deepEqual(yield* Fiber.join(outside), [{ recovery_value: 43 }]);
          assert.deepEqual(yield* sql`SELECT 42 AS recovery_value`, [{ recovery_value: 42 }]);
        }),
      {},
      recoveryPrelude(point, [261]),
    ),
);
it.effect.each([
  { point: "prepare", code: 5 },
  { point: "prepare", code: 517 },
  { point: "execute", code: 5 },
  { point: "execute", code: 517 },
] as const)("does not retry SQLite $code at writer $point", ({ point, code }) =>
  withWriterClient(
    (sql) =>
      Effect.gen(function* () {
        const failed = yield* sql`SELECT 42 AS recovery_value`.pipe(Effect.flip);
        assert.equal(failed.reason.operation, point);
        assert.propertyVal(failed.reason.cause, "errcode", code);
        assert.propertyVal(failed.reason.cause, "errno", code);
        assert.deepEqual(yield* sql`SELECT 42 AS recovery_value`, [{ recovery_value: 42 }]);
      }),
    {},
    recoveryPrelude(point, [code]),
  ),
);

it.effect("bounds writer WAL recovery to 500 delayed attempts", () =>
  withWriterClient(
    (sql) =>
      Effect.gen(function* () {
        using failures = observeFailures(startedWorkers.at(-1)!, 501);
        const waiting = yield* sql`SELECT 42 AS recovery_value`.pipe(Effect.flip, Effect.forkChild);
        for (const milestone of failures.milestones.slice(0, -1)) {
          yield* Deferred.await(milestone);
          yield* TestClock.adjust("10 millis");
        }
        yield* Deferred.await(failures.milestones.at(-1)!);
        assert.propertyVal((yield* Fiber.join(waiting)).reason.cause, "errcode", 261);
      }),
    {},
    recoveryPrelude("execute", [261], true),
  ),
);

it.effect("does not cache a failed preparation or disguise constraint errors", () =>
  withWriterClient((sql) =>
    Effect.gen(function* () {
      const query = sql`SELECT name FROM missing_table`;
      assert.equal((yield* query.pipe(Effect.flip)).reason.operation, "prepare");
      yield* sql`CREATE TABLE missing_table(name TEXT UNIQUE NOT NULL)`;
      yield* sql`INSERT INTO missing_table VALUES ('taken')`;
      assert.deepEqual(yield* query, [{ name: "taken" }]);
      assert.equal(
        (yield* sql`INSERT INTO missing_table VALUES ('taken')`.pipe(Effect.flip)).reason._tag,
        "UniqueViolation",
      );
      assert.equal(
        (yield* sql`INSERT INTO missing_table VALUES (NULL)`.pipe(Effect.flip)).reason._tag,
        "ConstraintError",
      );
    }),
  ),
);

it.effect(
  "denies leaving WAL with reader or checkpoint workers even in commented schema pragmas",
  () =>
    Effect.gen(function* () {
      for (const options of [{ readerWorker: true }, { checkpointWorker: true }]) {
        yield* withWriterClient(
          (sql) =>
            Effect.gen(function* () {
              const worker = startedWorkers[0]!;
              for (const statement of [
                "PRAGMA journal_mode = DELETE",
                '/* guarded */ PRAGMA main."journal_mode"(TRUNCATE)',
              ]) {
                const error = yield* sql.unsafe(statement).pipe(Effect.flip);
                assert.propertyVal(error.reason.cause, "errcode", 23);
              }
              assert.deepEqual(yield* sql`PRAGMA journal_mode`, [{ journal_mode: "wal" }]);
              assert.equal(startedWorkers.length, 1);
              assert.equal(startedWorkers[0], worker);
            }),
          options,
        );
      }
    }),
);

it.effect("bounds cached statements by capacity TTL and the size of their retained bindings", () =>
  withWriterClient(
    (sql) =>
      Effect.gen(function* () {
        const query = (value: string) =>
          sql.unsafe<{ prepares: number }>(
            "SELECT length(?) AS cache_probe, cache_prepares() AS prepares",
            [value],
          );
        assert.equal((yield* query("x".repeat(65537)))[0]?.prepares, 1);
        assert.equal((yield* query("small"))[0]?.prepares, 2);
        assert.equal((yield* query("small"))[0]?.prepares, 2);
        assert.equal((yield* query("x".repeat(65537)))[0]?.prepares, 3);
        assert.equal((yield* query("small"))[0]?.prepares, 3);
        yield* sql`SELECT 1`;
        assert.equal((yield* query("small"))[0]?.prepares, 4);
        yield* sql`SELECT cache_tick(1000)`.unprepared;
        assert.equal((yield* query("small"))[0]?.prepares, 5);
      }),
    { prepareCacheSize: 1, prepareCacheTTL: "1 second" },
    `
(() => {
  const sqlite = require("node:sqlite");
  const Original = sqlite.DatabaseSync;
  let tick = 0;
  let prepares = 0;
  Object.defineProperty(require("node:perf_hooks").performance, "now", { value: () => tick });
  sqlite.DatabaseSync = class extends Original {
    constructor(...args) {
      super(...args);
      this.function("cache_tick", (ms) => tick += ms);
      this.function("cache_prepares", () => prepares);
    }
    prepare(sql) {
      if (sql.includes("AS cache_probe")) prepares++;
      return super.prepare(sql);
    }
  };
})();
`,
  ),
);

it.effect("fails startup without running inline SQLite", () =>
  Effect.gen(function* () {
    let calls = 0;
    using _prepare = vi
      .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
      .mockImplementation(() => {
        calls++;
        throw new Error("inline fallback");
      });
    const failed = yield* withWriterClient(
      () => Effect.void,
      {},
      'throw new Error("startup failed");\n',
    ).pipe(Effect.result);
    assert.isTrue(Result.isFailure(failed));
    assert.equal(calls, 0);
    assert.equal(startedWorkers.length, 1);
    yield* awaitWorkerExit(startedWorkers[0]!);
    assert.equal(startedWorkers[0]?.threadId, -1);
  }),
);

it.effect(
  "retires a missing startup acknowledgement and ignores late ready without sending close",
  () =>
    Effect.gen(function* () {
      setup();
      const held = yield* Deferred.make<void>();
      let restore = () => {};
      let closeRequests = 0;
      nativeFixture.onStart = (worker) => {
        const emit = worker.emit.bind(worker);
        const messages = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
          if (event === "message" && args[0]?.type === "ready") {
            Deferred.doneUnsafe(held, Effect.void);
            return true;
          }
          return emit(event, ...args);
        });
        const post = worker.postMessage.bind(worker);
        const sending = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
          if (message?.type === "close") closeRequests++;
          post(message, ...rest);
        });
        restore = () => {
          messages.mockRestore();
          sending.mockRestore();
        };
      };
      yield* Effect.addFinalizer(() => Effect.sync(restore));
      const starting = yield* Layer.build(
        SqliteClient.layer({ filename: ":memory:", writerWorker: true }),
      ).pipe(Effect.scoped, Effect.exit, Effect.forkChild);
      yield* Deferred.await(held);
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
      const worker = startedWorkers[0]!;
      yield* awaitWorkerExit(worker);
      assert.equal(worker.threadId, -1);
      assert.equal(closeRequests, 0);
      restore();
      worker.emit("message", { type: "ready" });
      assert.equal(startedWorkers.length, 1);
    }).pipe(Effect.scoped),
);

it.effect("retries writer opening for WAL_RECOVERY on the parent clock", () =>
  Effect.gen(function* () {
    setup();
    const failedOpen = yield* Deferred.make<void>();
    nativeFixture.prelude = recoveryPrelude("initialize", [261]);
    nativeFixture.onStart = (worker) =>
      worker.on("message", (reply) => {
        if (reply?.type === "unavailable") Deferred.doneUnsafe(failedOpen, Effect.void);
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-open-" });
    const opening = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql`SELECT 42 AS recovery_value`;
    }).pipe(
      Effect.provide(
        SqliteClient.layer({
          filename: path.join(directory, "state.sqlite"),
          writerWorker: true,
          checkpointWorker: true,
        }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(failedOpen);
    yield* TestClock.adjust("10 millis");
    assert.deepEqual(yield* Fiber.join(opening), [{ recovery_value: 42 }]);
    assert.equal(startedWorkers.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns startup failure promptly but scope close awaits native retirement", () =>
  Effect.gen(function* () {
    setup();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-startup-held-" });
    const filename = path.join(directory, "state.sqlite");
    const seed = new NodeSqlite.DatabaseSync(filename);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.close();
    nativeFixture.prelude = initialCheckpointPrelude;
    const workerStarted = yield* Deferred.make<void>();
    let held: ReturnType<typeof holdInitialCheckpoint> | undefined;
    nativeFixture.onStart = (worker) => {
      held = holdInitialCheckpoint(worker);
      Deferred.doneUnsafe(workerStarted, Effect.void);
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => held?.[Symbol.dispose]()));
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const starting = yield* makeWriter(
      { filename, writerWorker: true, checkpointWorker: true },
      (effect) => effect,
      () => new Error("unsupported stream"),
      () => undefined,
    ).pipe(Scope.provide(scope), Effect.exit, Effect.forkChild);
    yield* Deferred.await(workerStarted);
    yield* Deferred.await(held!.arrived);
    yield* TestClock.adjust("10 seconds");
    const deadlineResult = starting.pollUnsafe();
    assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
    const closing = yield* Scope.close(scope, Exit.void).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const returnedBeforeRetirement = closing.pollUnsafe() !== undefined;
    held!.release();
    yield* Fiber.join(closing);
    assert.isTrue(held!.aliveAtRetirement, "the native wait must outlive the startup deadline");
    assert.isDefined(held!.retirement, "startup failure must retire its owned worker");
    assert.isDefined(deadlineResult, "startup must return before native termination completes");
    assert.isFalse(returnedBeforeRetirement, "scope close must await its retiring worker");
    assert.equal(startedWorkers.length, 1);
    assert.equal(startedWorkers[0]!.threadId, -1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "attributes native preparation and execution to their caller before transport or checkpoints",
  () =>
    withWriterClient(
      (sql) =>
        Effect.gen(function* () {
          const owner = "test.writerNativeTiming";
          yield* sql`SELECT 1`.pipe(Effect.withSpan(owner));
          const operations = recentSlowSql(1234567).filter((entry) => entry.owner === owner);
          assert.deepEqual(
            operations.map((entry) => [entry.connection, entry.operation, entry.nativeMs]),
            [
              ["writer", "prepare", 75],
              ["writer", "execute", 75],
            ],
          );
        }),
      {},
      `
(() => {
  const sqlite = require("node:sqlite");
  let tick = 0;
  Object.defineProperty(require("node:perf_hooks").performance, "now", { value: () => tick });
  Date.now = () => 1234567;
  for (const [prototype, method] of [[sqlite.DatabaseSync.prototype, "prepare"], [sqlite.StatementSync.prototype, "all"]]) {
    const original = prototype[method];
    prototype[method] = function(...args) {
      try { return original.apply(this, args); } finally { tick += 75; }
    };
  }
})();
`,
    ),
);

it.effect(
  "reports a held post-ready checkpoint once and recovers when its request completes",
  () => {
    const notices = captureWriterNotices();
    return withWriterClient(
      (sql) =>
        Effect.gen(function* () {
          yield* sql`CREATE TABLE held_maintenance(value BLOB)`;
          using held = holdMaintenance(startedWorkers[0]!);
          yield* sql`INSERT INTO held_maintenance VALUES (zeroblob(8 * 1024 * 1024))`;
          yield* Deferred.await(held.arrived);
          const transaction = yield* sql.withTransaction(sql`SELECT 1`).pipe(Effect.forkChild);
          yield* Deferred.await(held.requested);
          yield* TestClock.adjust("60 seconds");
          yield* notices.stalled;
          const warningsWhileHeld = notices.warnings.length;
          held.release();
          yield* Fiber.join(transaction);
          assert.equal(warningsWhileHeld, 1, "a held request must report degradation once");
          assert.equal(notices.warnings.length, 1);
          assert.equal(notices.recoveries.length, 1);
        }),
      { checkpointWorker: true },
      maintenancePrelude,
    ).pipe(Effect.provide(notices.layer));
  },
);

it.effect("reports sustained pinned-reader admission pressure with frame counts and recovery", () =>
  Effect.gen(function* () {
    setup();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-existing-wal-" });
    const filename = path.join(directory, "state.sqlite");
    const open = (readonly = false) =>
      Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename, { readOnly: readonly })),
        (db) => Effect.sync(() => db.close()),
      );
    const seed = yield* open();
    seed.exec("PRAGMA page_size = 4096; PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    seed.exec("CREATE TABLE existing_wal(value BLOB); INSERT INTO existing_wal VALUES ('initial')");
    const reader = yield* open(true);
    reader.exec("BEGIN");
    reader.prepare("SELECT value FROM existing_wal").all();
    seed.exec("INSERT INTO existing_wal VALUES (zeroblob(42 * 1024 * 1024))");
    assert.isAtLeast(Number(seed.prepare("PRAGMA wal_checkpoint(NOOP)").get()?.log), 10000);
    const notices = captureWriterNotices();
    const retries = yield* gateAdmissionRetries;
    const startupCheckpoints: Array<string> = [];
    let ready = false;
    nativeFixture.prelude = `
(() => {
  const { parentPort } = require("node:worker_threads");
  const sqlite = require("node:sqlite");
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function(sql) {
    if (/wal_checkpoint\\((PASSIVE|TRUNCATE)\\)/.test(sql))
      parentPort.postMessage({ type: "checkpoint-observed", sql });
    return prepare.call(this, sql);
  };
})();
`;
    nativeFixture.onStart = (worker) =>
      worker.on("message", (reply) => {
        if (reply?.type === "ready") ready = true;
        if (reply?.type === "checkpoint-observed" && !ready) startupCheckpoints.push(reply.sql);
      });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(startupCheckpoints, [], "startup must only observe WAL pressure");
      const firstReply = yield* Deferred.make<{ backpressure?: boolean }>();
      const worker = startedWorkers[0]!;
      const listener = (reply: { id?: number; backpressure?: boolean }) => {
        if (reply.id !== undefined) {
          worker.off("message", listener);
          Deferred.doneUnsafe(firstReply, Effect.succeed(reply));
        }
      };
      worker.on("message", listener);
      yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", listener)));
      const transaction = yield* sql
        .withTransaction(sql`INSERT INTO existing_wal VALUES ('after pressure')`)
        .pipe(Effect.provideService(Clock.Clock, retries.clock), Effect.forkChild);
      assert.isTrue(
        (yield* Deferred.await(firstReply)).backpressure,
        "the first BEGIN must be refused before it executes",
      );
      assert.isUndefined(transaction.pollUnsafe());
      assert.equal(seed.prepare("SELECT COUNT(*) AS count FROM existing_wal").get()?.count, 2);
      const firstRetry = yield* retries.nextRetry;
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.succeed(firstRetry, undefined);
      yield* TestClock.adjust("100 millis");
      yield* notices.admissionDegraded;
      const secondRetry = yield* retries.nextRetry;
      yield* Deferred.succeed(secondRetry, undefined);
      yield* TestClock.adjust("100 millis");
      const thirdRetry = yield* retries.nextRetry;
      const warningsUnderPressure = notices.warnings.slice();
      assert.equal(notices.recoveries.length, 0);
      reader.exec("ROLLBACK");
      yield* notices.admissionRecovered;
      yield* Deferred.succeed(thirdRetry, undefined);
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(transaction);
      assert.equal(
        warningsUnderPressure.length,
        1,
        "persistent refusals must report degradation once",
      );
      assert.match(String(warningsUnderPressure[0]), /walFrames.*10[0-9]{3}/);
      assert.match(String(warningsUnderPressure[0]), /checkpointedFrames/);
      assert.equal(notices.recoveries.length, 1);
      assert.equal((yield* sql`SELECT COUNT(*) AS count FROM existing_wal`)[0]?.count, 3);
      assert.equal(startedWorkers.length, 1);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename, writerWorker: true, checkpointWorker: true }).pipe(
          Layer.provideMerge(notices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["frames", "journal-size"] as const)(
  "pauses mutations under pinned-reader %s pressure and resumes after zero-busy truncate",
  (pressure) =>
    withWriterClient(
      (sql, filename) =>
        Effect.gen(function* () {
          yield* sql`PRAGMA busy_timeout = 5000`;
          yield* sql`CREATE TABLE checkpoint_probe(value BLOB)`;
          yield* sql`INSERT INTO checkpoint_probe VALUES ('initial')`;
          if (pressure === "journal-size") yield* sql`PRAGMA journal_size_limit = 4096`;
          const reader = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(filename, { readOnly: true })),
            (db) => Effect.sync(() => db.close()),
          );
          reader.exec("BEGIN");
          reader.prepare("SELECT value FROM checkpoint_probe").all();
          const worker = startedWorkers.at(-1)!;
          let refused = yield* Deferred.make<void>();
          const truncations: Array<number> = [];
          const listener = (reply: { backpressure?: boolean; type?: string; timeout?: number }) => {
            if (reply.backpressure) Deferred.doneUnsafe(refused, Effect.void);
            if (reply.type === "truncate-observed" && reply.timeout !== undefined)
              truncations.push(reply.timeout);
          };
          worker.on("message", listener);
          yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", listener)));
          if (pressure === "frames")
            yield* sql`INSERT INTO checkpoint_probe VALUES (zeroblob(42 * 1024 * 1024))`;
          else yield* sql`INSERT INTO checkpoint_probe VALUES (zeroblob(8192))`;
          const cancelled = yield* sql
            .withTransaction(sql`INSERT INTO checkpoint_probe VALUES ('cancelled before BEGIN')`)
            .pipe(Effect.forkChild);
          yield* Deferred.await(refused);
          yield* Fiber.interrupt(cancelled);
          refused = yield* Deferred.make<void>();
          const mutation = yield* sql`INSERT INTO checkpoint_probe VALUES ('after pressure')`.pipe(
            Effect.forkChild,
          );
          yield* Deferred.await(refused);
          assert.isUndefined(mutation.pollUnsafe());
          using recovery = awaitAdmissionRecovery(worker);
          reader.exec("ROLLBACK");
          yield* recovery.recovered;
          yield* TestClock.adjust("100 millis");
          yield* Fiber.join(mutation);
          assert.equal((yield* sql`SELECT COUNT(*) AS count FROM checkpoint_probe`)[0]?.count, 3);
          assert.equal((yield* sql`PRAGMA busy_timeout`)[0]?.timeout, 5000);
          assert.isAbove(truncations.length, 0);
          assert.isTrue(truncations.every((timeout) => timeout === 0));
          assert.equal(startedWorkers.length, 1);
        }).pipe(Effect.scoped),
      { checkpointWorker: true },
      `
(() => {
  const { parentPort } = require("node:worker_threads");
  const sqlite = require("node:sqlite");
  const original = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function(sql) {
    if (sql === "PRAGMA wal_checkpoint(TRUNCATE)")
      parentPort.postMessage({ type: "truncate-observed", timeout: original.call(this, "PRAGMA busy_timeout").get().timeout });
    return original.call(this, sql);
  };
})();
`,
    ),
);

it.effect(
  "rejects stale requests and a different transaction owner before either can execute",
  () =>
    Effect.gen(function* () {
      setup();
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new NodeWorkerThreads.Worker(writerWorkerSource, {
              eval: true,
              workerData: {
                filename: ":memory:",
                readonly: false,
                allowExtension: false,
                checkpoint: false,
                protectJournal: false,
                prepareCacheSize: 2,
                prepareCacheTTL: 60000,
              },
            }),
        ),
        (owned) => Effect.promise(() => owned.terminate()),
      );
      const send = (request: {
        id?: number;
        type?: string;
        sql?: string;
        owner?: number;
        params?: ReadonlyArray<unknown>;
      }) =>
        Effect.callback<{ rows?: unknown; error?: { message: string } }>((resume) => {
          const listener = (reply: {
            id?: number;
            type?: string;
            rows?: unknown;
            error?: { message: string };
          }) => {
            if (request.type === "initialize" ? reply.type !== "ready" : reply.id !== request.id)
              return;
            worker.off("message", listener);
            resume(Effect.succeed(reply));
          };
          worker.on("message", listener);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers have no target origin.
          worker.postMessage({ params: [], safeIntegers: false, values: false, ...request });
          return Effect.sync(() => worker.off("message", listener));
        });
      yield* send({ type: "initialize" });
      yield* send({ id: 1, sql: "BEGIN", owner: 1 });
      assert.include(
        (yield* send({ id: 2, sql: "CREATE TABLE forbidden(value)", owner: 2 })).error?.message,
        "owner mismatch",
      );
      yield* send({ id: 3, sql: "ROLLBACK", owner: 1 });
      assert.include(
        (yield* send({ id: 3, sql: "CREATE TABLE forbidden(value)", owner: 1 })).error?.message,
        "Out of order",
      );
      assert.deepEqual(
        (yield* send({
          id: 4,
          sql: "SELECT name FROM sqlite_schema WHERE name = 'forbidden'",
          owner: 3,
        })).rows,
        [],
      );
      yield* send({ id: 5, type: "close" });
    }).pipe(Effect.scoped),
);

it.effect("keeps parent control live while a COMMIT reply is held and commits once", () =>
  withWriterClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE commit_probe(value TEXT)`;
      using held = holdReply(startedWorkers.at(-1)!, "COMMIT");
      const transaction = yield* sql
        .withTransaction(sql`INSERT INTO commit_probe VALUES ('committed once')`)
        .pipe(Effect.forkChild);
      yield* Deferred.await(held.arrived);
      const control = yield* Effect.callback<string>((resume) => {
        const immediate = setImmediate(() => resume(Effect.succeed("parent control ran")));
        return Effect.sync(() => clearImmediate(immediate));
      });
      assert.equal(control, "parent control ran");
      assert.isUndefined(transaction.pollUnsafe());
      held.release();
      yield* Fiber.join(transaction);
      assert.deepEqual(yield* sql`SELECT value FROM commit_probe`, [{ value: "committed once" }]);
    }),
  ),
);
