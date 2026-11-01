import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Store from "../MemoryStore.ts";

it.effect("the per-sweep scan for rejected forgets runs on the reader connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-forget-reader-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    yield* Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const spans: Array<Tracer.Span> = [];
      const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
        const [query] = statement.compile();
        if (query.includes("$.tombstone.deletedAtUtc")) spans.push(span);
        return Effect.succeed(statement);
      };
      const pending = yield* store
        .pendingForgetIntents(10)
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
        );
      assert.deepEqual(pending, []);
      assert.equal(spans.length, 1);
      assert.equal(spans[0]?.attributes.get("db.connection"), "reader");
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(database))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
