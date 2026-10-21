import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Store from "./MemoryStore.ts";
import * as Worker from "./MemoryWorker.ts";

const environmentId = M.EnvironmentId.make("fresh-database");
const database = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "memory-sweep-fresh-" });
    return Sqlite.layerFromPath(`${home}/statev2.sqlite`);
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const storage = Store.layer.pipe(Layer.provideMerge(database));
const quota = Quota.layer.pipe(Layer.provideMerge(storage));
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
const service = Service.layer.pipe(
  Layer.provideMerge(quota),
  Layer.provide(identity),
  Layer.provide(
    Layer.mock(Repository.RepositoryIdentityResolver)({ resolve: () => Effect.succeed(null) }),
  ),
);
const live = (hub = false, configured = false) =>
  Worker.layer.pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(Maintenance.layer.pipe(Layer.provideMerge(quota))),
    Layer.provide(identity),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Settings.layerTest(
        {
          ...(hub
            ? {
                memoryHub: {
                  mode: "hub",
                  memorySpaceId: M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001"),
                },
              }
            : {}),
          ...(configured
            ? {
                memoryModelSelection: {
                  instanceId: M.ProviderInstanceId.make("codex"),
                  model: "fixture",
                },
              }
            : {}),
        },
        "memoryHub",
      ),
    ),
    Layer.provide(Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "fresh-worker" })),
    Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
    Layer.provide(
      Layer.mock(Generation.TextGeneration)({
        generateMemorySummary: () => Effect.die("empty database must not invoke a provider"),
      }),
    ),
  );

it.effect("sweeps an empty database migrated through 073 with the default disabled hub", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-10-15T00:00:00.000Z"));
    const worker = yield* Worker.MemoryWorker;
    const store = yield* Store.MemoryStore;
    yield* worker.sweepDue();
    assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
    yield* worker.start();
    yield* worker.drain;
    assert.strictEqual((yield* store.ftsState(environmentId)).state, "open");
  }).pipe(Effect.scoped, Effect.provide(live())),
);

it.effect.each([
  { hub: false, configured: false },
  { hub: false, configured: true },
  { hub: true, configured: false },
  { hub: true, configured: true },
])(
  "advances past a non-summary thread event (hub=$hub, model=$configured)",
  ({ hub, configured }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES ('fresh-event','thread','fresh-thread',0,'thread.created','2026-10-15T00:00:00.000Z','server','{}','{}',2)`;
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      const store = yield* Store.MemoryStore;
      assert.strictEqual(yield* store.readThreadHookWatermark(), 1);
      yield* worker.start();
      yield* worker.drain;
      assert.isNotNull((yield* store.ftsState(environmentId)).measuredAt);
    }).pipe(Effect.scoped, Effect.provide(live(hub, configured))),
);

it.effect.each(["catch-up", "maintenance"] as const)(
  "keeps a real storage failure visible with a safe %s warning",
  (stage) => {
    const warnings: unknown[] = [];
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (stage === "catch-up") yield* sql`DROP TABLE orchestration_events`;
      else
        yield* sql`CREATE TRIGGER fail_sample BEFORE INSERT ON memory_compaction_state BEGIN SELECT RAISE(ABORT,'synthetic private diagnostic'); END`;
      const worker = yield* Worker.MemoryWorker;
      const error = yield* worker.sweepDue().pipe(Effect.flip);
      assert.strictEqual(error.code, "storage_failed");
      assert.strictEqual(error.stage, stage);
      assert.isDefined(error.cause);
      // A failed sample is retried once per sample interval, so the started worker only
      // reaches it again after that interval.
      if (stage === "maintenance")
        yield* TestClock.adjust(Maintenance.MEMORY_STORAGE_SAMPLE_INTERVAL_MS);
      yield* worker.start();
      yield* worker.drain;
      assert.isAtLeast(warnings.length, 1);
      for (const warning of warnings)
        assert.deepStrictEqual(warning, [
          "Memory sweep deferred",
          { code: "storage_failed", stage },
        ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          live(),
          Logger.layer([
            Logger.make(({ message }) => {
              if (Array.isArray(message) && message[0] === "Memory sweep deferred")
                warnings.push(message);
            }),
          ]),
        ),
      ),
    );
  },
);

it.effect("r3 disabled maintenance continues report pages and waits after a complete pass", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const worker = yield* Worker.MemoryWorker;
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const seed = (n: number) =>
      Effect.gen(function* () {
        const space = M.MemorySpaceId.make(uuid((n % 2) + 1));
        const operationId = M.MemoryOperationId.make(uuid(n + 100));
        const resolutionId = M.MemoryResolutionId.make(uuid(9));
        const memoryId = M.MemoryId.make(uuid(8));
        const foreign = M.EnvironmentId.make("foreign");
        const reportId = Store.resolutionReportId(space, operationId, resolutionId);
        yield* store.persistCompactReceipt({
          memorySpaceId: space,
          originEnvironmentId: foreign,
          operationKind: "revert",
          receipt: {
            operationId,
            memoryId,
            operationDigest: "a".repeat(64),
            outcome: "accepted",
            hubSequence: n + 1,
          },
          revisionId: M.MemoryRevisionId.make(uuid(n + 1000)),
          resolutionId,
          revertsResolutionId: resolutionId,
          attemptId: null,
          fencingToken: null,
          reportGuard: {
            reportId,
            resolvingEnvironmentId: foreign,
            resolutionId,
            outcome: "reverted",
          },
        });
        yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at) VALUES (${reportId},${space},${memoryId},${operationId},${resolutionId},${foreign},'reverted','pending',0)`;
      });
    for (let n = 0; n < 258; n++) yield* seed(n);
    const count = Effect.map(
      sql<{ count: number }>`SELECT count(*) AS count FROM memory_report_outbox`,
      (rows) => rows[0]!.count,
    );
    yield* worker.sweepDue();
    assert.strictEqual(yield* count, 2);
    yield* worker.sweepDue();
    assert.strictEqual(yield* count, 0);
    yield* seed(300);
    yield* worker.sweepDue();
    assert.strictEqual(yield* count, 1);
    yield* TestClock.setTime(60_000);
    yield* worker.sweepDue();
    assert.strictEqual(yield* count, 0);
    assert.strictEqual((yield* sql`SELECT 1 FROM memory_compact_receipts`).length, 259);
  }).pipe(Effect.scoped, Effect.provide(live())),
);
