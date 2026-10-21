import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Metric from "effect/Metric";

import * as ServerConfig from "../config.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as Settings from "../serverSettings.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadHistoryArchive from "../orchestration-v2/ThreadHistoryArchive.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(ThreadHistoryArchive.layer),
    Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provide(Settings.layerTest()),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("takes memory from the memory store's own sample and compacts history on demand", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    const mib = 1024 * 1024;
    yield* sql`CREATE TABLE thread_history (body BLOB)`;
    yield* sql`INSERT INTO thread_history VALUES (zeroblob(${3 * mib}))`;
    yield* Metric.update(
      Metric.withAttributes(Metrics.memoryStoreBytes, { area: "total" }),
      2 * mib,
    );
    const [first, second] = yield* Effect.all([storage.compactNow, storage.compactNow], {
      concurrency: "unbounded",
    });
    assert.equal(first.memoryBytes, 2 * mib);
    assert.equal(first.historyBytes, first.databaseBytes - first.reclaimableBytes - 2 * mib);
    assert.isAtLeast(first.databaseBytes, 3 * mib);
    assert.isUndefined(first.compactingSince);
    assert.equal(first.lastCompaction?.removedEvents, 0);
    // The second call joined the first run instead of starting another.
    assert.equal(second.lastCompaction?.finishedAt, first.lastCompaction?.finishedAt);
    assert.deepEqual(yield* storage.health, first);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);
