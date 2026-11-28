import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "./nodeSqliteClient.ts";

it.effect.each([false, true])(
  "Unicode title matching works on reader and writer connections (writer worker: %s)",
  (writerWorker) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-sqlite-case-" });
      const filename = path.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        const query = sql<{
          readonly matched: number;
        }>`SELECT goat_case_contains('Kelvin', 'k') AS matched`;
        assert.equal((yield* query)[0]?.matched, 1);
        assert.equal((yield* query.pipe(SqliteClient.readOnly))[0]?.matched, 1);
      }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true, writerWorker })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
