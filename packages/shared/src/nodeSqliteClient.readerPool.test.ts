import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";

it.live("serves another read while a read transaction is held", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-reader-pool-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT 1`;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(entered);
      const other = yield* sql<{ value: number }>`SELECT 2 AS value`.pipe(SqliteClient.readOnly);
      assert.equal(other[0]?.value, 2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: path.join(directory, "state.sqlite"), readerWorker: true }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("runs four read transactions at once and makes a fifth read wait for a slot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-reader-pool-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      const order: Array<string> = [];
      const releases = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>());
      const entered = Array.from({ length: 4 }, () => Deferred.makeUnsafe<void>());
      const holders = [];
      for (const [index, release] of releases.entries())
        holders.push(
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT 1`;
                yield* Deferred.succeed(entered[index]!, undefined);
                yield* Deferred.await(release);
              }),
            )
            .pipe(SqliteClient.readOnly, Effect.forkChild),
        );
      for (const started of entered) yield* Deferred.await(started);
      // Every slot is held, so the fifth read can finish only after a slot is returned.
      const fifth = yield* sql`SELECT 5 AS value`.pipe(
        SqliteClient.readOnly,
        Effect.tap(() => Effect.sync(() => order.push("fifth"))),
        Effect.forkChild,
      );
      order.push("released");
      yield* Deferred.succeed(releases[0]!, undefined);
      assert.deepEqual(yield* Fiber.join(fifth), [{ value: 5 }]);
      assert.deepEqual(order, ["released", "fifth"]);
      for (const release of releases) yield* Deferred.succeed(release, undefined);
      for (const holder of holders) yield* Fiber.join(holder);
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: path.join(directory, "state.sqlite"), readerWorker: true }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
