import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Result from "effect/Result";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";
import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      startedWorkers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("keeps transaction ownership through ordered worker statements and rollback", () =>
  Effect.gen(function* () {
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
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-contract-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true })));
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
  withWriterClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE uncertain_probe(value INTEGER)`;
      const worker = startedWorkers.at(-1)!;
      const replied = yield* Deferred.make<void>();
      let heldId: number | undefined;
      const post = worker.postMessage.bind(worker);
      using sending = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
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
      using losing = vi.spyOn(worker, "emit").mockImplementation((event, ...args) => {
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
  ),
);
