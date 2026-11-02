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
