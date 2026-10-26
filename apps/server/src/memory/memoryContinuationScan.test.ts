import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { selectContinuationCandidates } from "./memoryContinuationScan.ts";

it.effect("the continuation scan runs on the reader connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-continuation-reader-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const spans: Array<Tracer.Span> = [];
      const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
        const [query] = statement.compile();
        if (query.includes("WITH progress AS MATERIALIZED")) spans.push(span);
        return Effect.succeed(statement);
      };
      const rows = yield* selectContinuationCandidates(sql, {
        environmentId: "environment:test",
        watermark: 100,
        now: 0,
        limit: 10,
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, observe),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
      assert.deepEqual(rows, []);
      assert.equal(spans.length, 1);
      assert.equal(spans[0]?.attributes.get("db.connection"), "reader");
    }).pipe(Effect.provide(database));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
