import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeSqlite from "node:sqlite";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
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
const withWriterClient = <A, E>(
  use: (sql: SqlClient.SqlClient, filename: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
  options: Partial<SqliteClient.SqliteClientConfig> = {},
) =>
  Effect.gen(function* () {
    startedWorkers.length = 0;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-burst-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, writerWorker: true, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("allows writes with a 48 MiB WAL pinned by a reader", () =>
  withWriterClient(
    (sql, filename) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE burst_probe(value BLOB)`;
        yield* sql`INSERT INTO burst_probe VALUES ('initial')`;
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename, { readOnly: true })),
          (db) => Effect.sync(() => db.close()),
        );
        reader.exec("BEGIN");
        reader.prepare("SELECT value FROM burst_probe").all();
        yield* sql`INSERT INTO burst_probe VALUES (zeroblob(48 * 1024 * 1024))`;
        const worker = startedWorkers.at(-1)!;
        const reply = yield* Deferred.make<boolean | undefined>();
        const listener = (message: { id?: number; backpressure?: boolean }) => {
          if (message.id !== undefined)
            Deferred.doneUnsafe(reply, Effect.succeed(message.backpressure));
        };
        worker.on("message", listener);
        yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", listener)));
        const write = yield* sql`INSERT INTO burst_probe VALUES ('after burst')`.pipe(
          Effect.forkChild,
        );
        const blocked = yield* Deferred.await(reply);
        yield* Fiber.interrupt(write);
        reader.exec("ROLLBACK");
        assert.isFalse(blocked);
      }).pipe(Effect.scoped),
    { checkpointWorker: true },
  ),
);

it.effect("the checkpoint worker keeps a 48 MiB pinned WAL below backpressure", () =>
  withWriterClient(
    (sql, filename) =>
      Effect.gen(function* () {
        yield* sql`CREATE TABLE checkpoint_burst(value BLOB)`;
        yield* sql`INSERT INTO checkpoint_burst VALUES ('initial')`;
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => new NodeSqlite.DatabaseSync(filename, { readOnly: true })),
          (db) => Effect.sync(() => db.close()),
        );
        reader.exec("BEGIN");
        reader.prepare("SELECT value FROM checkpoint_burst").all();
        yield* sql`INSERT INTO checkpoint_burst VALUES (zeroblob(48 * 1024 * 1024))`;
        const worker = startedWorkers.at(-1)!;
        const observed = yield* Deferred.make<{
          log: number;
          checkpointed: number;
          blocked: boolean;
        }>();
        const listener = (message: {
          type?: string;
          log?: number;
          checkpointed?: number;
          blocked?: boolean;
        }) => {
          if (
            message.type === "checkpoint" &&
            typeof message.log === "number" &&
            message.log > 10_000 &&
            typeof message.checkpointed === "number" &&
            typeof message.blocked === "boolean"
          )
            Deferred.doneUnsafe(
              observed,
              Effect.succeed({
                log: message.log,
                checkpointed: message.checkpointed,
                blocked: message.blocked,
              }),
            );
        };
        worker.on("message", listener);
        yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", listener)));
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
        const state = yield* Deferred.await(observed);
        reader.exec("ROLLBACK");
        assert.isBelow(state.checkpointed, state.log);
        assert.isFalse(state.blocked);
      }).pipe(Effect.scoped),
    { writerWorker: false, checkpointWorker: true },
  ),
);
