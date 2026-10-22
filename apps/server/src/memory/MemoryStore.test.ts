import {
  checkUsage,
  scanRevertResultBytes,
  assertUsageCounters,
} from "./MemoryUsageScan.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Logger from "effect/Logger";
import * as Console from "effect/Console";
import * as References from "effect/References";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as Schema from "effect/Schema";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import migration from "../persistence/Migrations/076_Memory.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import hubMigration from "../persistence/Migrations/077_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/078_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/080_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/081_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/093_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/082_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/083_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/084_MemoryRevertResults.ts";
import readyMigration from "../persistence/Migrations/086_MemoryLastReadySpace.ts";
import adminMigration from "../persistence/Migrations/087_MemoryHubAdministered.ts";
import lifecycleMigration from "../persistence/Migrations/088_MemoryCheckpointLifecycle.ts";
import * as Store from "./MemoryStore.ts";
import { CheckpointAccountingError } from "./MemoryCheckpointAccounting.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture");
const now = "2026-10-14T00:00:00.000Z";
const hash = "a".repeat(64);
const fixtureCheckpointIdentity = {
  memorySpaceId: space,
  hubEnvironmentId: env,
  checkpointId: "fixture",
  expectedSnapshotToken: "synthetic-fixture",
  expectedCheckpointSequence: 1,
};
const beginFixtureCheckpoint = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  yield* store.transact(
    store.advanceBootstrapTx({
      ...fixtureCheckpointIdentity,
      expectedState: "unbound",
      nextState: "staging",
      snapshotToken: fixtureCheckpointIdentity.expectedSnapshotToken,
      checkpointSequence: fixtureCheckpointIdentity.expectedCheckpointSequence,
      nextCursor: null,
    }),
  );
});
const encodeSourceCollect = Schema.encodeEffect(
  Schema.fromJsonString(M.MemoryHubSourceReadCollectResult),
);
const encodeOperationJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryOperation));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(M.MemoryPayload));
const encodeCheckpointPage = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubCheckpointPage));
const decodeCheckpointPage = Schema.decodeEffect(Schema.fromJsonString(M.MemoryHubCheckpointPage));
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const operation = (n = 3) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(n),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId: id(n + 10),
      operationId: id(n),
      parents: [],
      scope: { kind: "user" },
      payloadRef: id(n + 10),
      assertionKind: "inference",
      provenance: { environmentId: env },
      createdAtUtc: now,
    },
    payload: { text: "synthetic searchable text", evidence: [], derivedFromMemoryRevisions: [] },
  });
const decision = (op = operation()): Store.MemoryDecision => ({
  operation: op,
  operationDigest: hash,
  admission: Store.localIntent,
  receipt: {
    operationId: op.operationId,
    memoryId: op.memoryId,
    pendingSync: true,
    revisionId: op.kind === "forget" ? null : op.revision.revisionId,
    outcome: op.kind === "forget" ? "deleted" : "accepted",
  },
  ...(op.kind !== "forget"
    ? {
        item: {
          memorySpaceId: space,
          memoryId: memory,
          status: "active",
          scope: op.revision.scope,
          revision: op.revision,
          payload: op.payload,
          pendingSync: true,
          localAvailability: {
            exposure: "visible",
            reasons: [],
            deferred: [],
            cleanupPending: false,
          },
        } as M.MemoryItem,
      }
    : {}),
});
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const setup = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
    Effect.andThen(readyMigration),
    Effect.andThen(adminMigration),
    Effect.andThen(lifecycleMigration),
    Effect.andThen(searchMigration),
  ),
).pipe(Layer.provideMerge(database));
const live = Store.layer.pipe(Layer.provideMerge(setup));

const checkpoint = () => {
  const op = operation();
  if (op.kind === "forget") throw new Error("Fixture kind");
  const item = decision(op).item!;
  return M.MemoryHubCheckpointPage.make({
    memorySpaceId: space,
    checkpointSequence: 1,
    retentionFloor: 0,
    causalBoundary: { checkpointSequence: 1, boundaryId: "fixture" },
    pageOrdinal: 0,
    items: [{ ...item, pendingSync: false }],
    revisions: [{ revision: op.revision, payload: op.payload }],
    tombstones: [],
    conflicts: [],
    resolutions: [],
    compactReceipts: [
      {
        memorySpaceId: space,
        originEnvironmentId: env,
        operationKind: "upsert",
        receipt: {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 1,
        },
        revisionId: op.revision.revisionId,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      },
    ],
    identities: [
      {
        memorySpaceId: space,
        memoryId: memory,
        scope: op.revision.scope,
        creatingEnvironmentId: env,
        createOperationId: op.operationId,
        createdAtUtc: now,
      },
    ],
    fences: [{ memorySpaceId: space, memoryId: memory, highestFencingToken: 0, activeLease: null }],
    suppressions: [],
    importLineage: [],
    nextCursor: null,
    bootstrapComplete: true,
  });
};
const approved = (op = operation()): Store.MemoryDecision => ({
  ...decision(op),
  admission: Store.approvedReplica,
  receipt: {
    operationId: op.operationId,
    memoryId: op.memoryId,
    operationDigest: hash,
    outcome: "accepted",
    hubSequence: 2,
  },
});
const childOperation = () => {
  const op = operation(4);
  if (op.kind === "forget") throw new Error("Fixture kind");
  const parent = M.MemoryRevisionId.make(id(13));
  return decodeOperation({
    ...op,
    expectedHeads: [parent],
    revision: { ...op.revision, parents: [parent] },
  });
};
const parked = (): Store.MemoryDecision => {
  const op = childOperation();
  if (op.kind === "forget") throw new Error("Fixture kind");
  return {
    ...approved(op),
    heads: [],
    pending: { missingParents: op.revision.parents, reason: "missing_parent" },
    item: {
      memorySpaceId: space,
      memoryId: memory,
      scope: op.revision.scope,
      status: "blocked",
      failureCode: "missing_parent",
      pendingSync: false,
      localAvailability: {
        exposure: "held",
        reasons: ["missing_parent"],
        cleanupPending: false,
        deferred: [
          {
            kind: "parent",
            state: "held",
            reason: "missing_parent",
            revisionId: op.revision.revisionId,
            generation: 0,
            sinceAtUtc: now,
          },
        ],
      },
    },
  };
};
const reconnected = () => approved(childOperation());
const backgroundWork = (id = "fixture:background"): Store.MemoryWork => ({
  id,
  space,
  memoryId: memory,
  kind: "rebuild",
  status: "pending",
  metadata: { kind: "rebuild", revisionId: null, generation: 0 },
  payloadRef: null,
  attempt: 0,
  nextAttemptAt: 0,
  claimedBy: null,
  claimedUntil: null,
});
const summaryWork = (n: number, environmentId = env): Store.MemoryWork => ({
  ...backgroundWork(`summary:${n}`),
  kind: "summary",
  metadata: {
    kind: "summary",
    sourceThread: { environmentId, threadId: M.ThreadId.make(id(70)) },
    sourceWatermark: {
      fromEventId: M.EventId.make(id(71)),
      toEventId: M.EventId.make(id(72)),
      throughSequence: n,
    },
    memoryId: memory,
    operationId: M.MemoryOperationId.make(id(n + 100)),
    revisionId: M.MemoryRevisionId.make(id(n + 200)),
    modelSelection: { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" },
  },
});
const deferredWork = (
  kind: Store.MemoryDeferredWork["kind"],
  overrides: Partial<Store.MemoryDeferredWork> = {},
) => ({
  kind,
  state: "pending" as const,
  reason: null,
  revisionId: null,
  generation: 1,
  sinceAtUtc: now,
  attempt: 0,
  dueAt: 0,
  lastAttemptAt: null,
  claimedBy: null,
  claimedUntil: null,
  ...overrides,
});
const seedDeferred = (
  n: number,
  entries: ReadonlyArray<ReturnType<typeof deferredWork>>,
  payloadBytes = 0,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memoryId = M.MemoryId.make(id(n));
    yield* sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json,generation,deferred_json) VALUES (${space},${memoryId},'{}','user','[]','blocked',0,'{}','{}',1,${JSON.stringify(entries)})`;
    if (payloadBytes)
      yield* sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${id(n)},${memoryId},${"x".repeat(payloadBytes)},'[]')`;
  });
describe("MemoryStore", () => {
  it.effect("rolls back each pre-commit failure boundary", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      for (const table of ["memory_payloads", "memory_events", "memory_items", "memory_outbox"]) {
        yield* sql.unsafe(
          `CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`,
        );
        assert.isTrue((yield* Effect.exit(store.apply(decision())))._tag === "Failure");
        for (const name of [
          "memory_payloads",
          "memory_revisions",
          "memory_events",
          "memory_items",
          "memory_outbox",
        ])
          assert.strictEqual((yield* sql.unsafe(`SELECT * FROM ${name}`)).length, 0);
        yield* sql`DROP TRIGGER fail_write`;
      }
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("preserves committed intent after a lost wakeup", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      const second = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.isDefined(yield* second.receipt(space, operation().operationId));
      assert.strictEqual((yield* second.readEligibleOutbox(space, 0, 100)).length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("serializes concurrent identical operation reservations", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const results = yield* Effect.all([store.apply(decision()), store.apply(decision())], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(results[0], results[1]);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).revisions.length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejects changed payload under an operation ID", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const original = yield* store.apply(decision());
      const result = yield* Effect.exit(
        store.apply({
          ...decision(),
          operationDigest: "b".repeat(64),
          receipt: decision().receipt,
        }),
      );
      assert.isTrue(result._tag === "Failure");
      assert.deepStrictEqual(yield* store.receipt(space, operation().operationId), original);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("received cursor commits with parked receipt or not at all", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const input = {
        memorySpaceId: space,
        hubEnvironmentId: env,
        expectedSequence: 0,
        afterSequence: 1,
      };
      yield* store
        .withReceivedCursor(input, Effect.andThen(store.apply(decision()), Effect.fail("barrier")))
        .pipe(Effect.exit);
      assert.strictEqual(yield* store.readCursor(space, env), 0);
      assert.isUndefined(yield* store.receipt(space, operation().operationId));
      yield* store.withReceivedCursor(input, store.apply(decision()));
      assert.strictEqual(yield* store.readCursor(space, env), 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("removes forgotten text from FTS and payload tables", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      yield* store.apply(decision(op));
      const aggregate = yield* store.loadAggregate(space, memory);
      if (op.kind !== "forget")
        yield* store.index({
          memorySpaceId: space,
          memoryId: memory,
          revisionId: op.revision.revisionId,
          generation: aggregate.generation,
        });
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      assert.strictEqual((yield* sql`SELECT * FROM memory_items_fts`).length, 0);
      assert.isFalse(
        op.kind !== "forget" &&
          (yield* store.index({
            memorySpaceId: space,
            memoryId: memory,
            revisionId: op.revision.revisionId,
            generation: aggregate.generation,
          })),
      );
      assert.isNull((yield* store.loadAggregate(space, memory)).revisions[0]?.payload);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("scope filter precedes paging", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      assert.strictEqual(
        (yield* store.list({
          memorySpaceId: space,
          scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "foreign" } },
          limit: 1,
        })).length,
        0,
      );
      assert.strictEqual(
        (yield* store.list({ memorySpaceId: space, scope: { kind: "user" }, limit: 1 })).length,
        1,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("examines an empty 1000-row window and reaches a later match in both modes", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      yield* store.apply(decision(op));
      const item = yield* store.loadAggregate(space, memory);
      if (op.kind === "forget") throw new Error("Fixture kind");
      yield* store.index({
        memorySpaceId: space,
        memoryId: memory,
        revisionId: op.revision.revisionId,
        generation: item.generation,
      });
      // Real keyset rows with no searchable body precede the active item.
      yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
        INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
        SELECT ${space},printf('00000000-0000-4000-8000-%012d',n),'{}','user','[]','quarantined',0,'{}','{}' FROM ids WHERE n!=2`;
      // Move the fixture to the tail while preserving its projection identity.
      const tail = M.MemoryId.make(id(1002));
      yield* sql`UPDATE memory_items SET memory_id=${tail},item_json=json_set(item_json,'$.memoryId',${tail},'$.revision.memoryId',${tail}) WHERE space=${space} AND memory_id=${memory}`;
      yield* store.searchCoverage({ memorySpaceId: space, scope: { kind: "user" }, limit: 100 });
      yield* store.searchCoverage({ memorySpaceId: space, scope: { kind: "user" }, limit: 100 });
      for (const mode of ["fts", "substring"] as const) {
        const first = yield* store.search(
          { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
          "synthetic",
          mode,
        );
        assert.deepStrictEqual(first.items, []);
        assert.strictEqual(first.examinedAfterMemoryId, id(1001));
        assert.isFalse(first.exhausted);
        const last = yield* store.search(
          {
            memorySpaceId: space,
            scope: { kind: "user" },
            limit: 100,
            afterMemoryId: first.examinedAfterMemoryId!,
          },
          "synthetic",
          mode,
        );
        assert.deepStrictEqual(
          last.items.map((i) => i.memoryId),
          [tail],
        );
        assert.strictEqual(last.examinedAfterMemoryId, tail);
        assert.isTrue(last.exhausted);
        const absent = yield* store.search(
          { memorySpaceId: space, scope: { kind: "user" }, limit: 100, afterMemoryId: tail },
          "synthetic",
          mode,
        );
        assert.isTrue(absent.exhausted);
      }
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN WITH window AS MATERIALIZED (SELECT rowid,memory_id FROM memory_items WHERE space=${space} AND scope_key='user' AND memory_id>'' ORDER BY memory_id LIMIT 1000) SELECT memory_id,EXISTS(SELECT 1 FROM memory_items_fts WHERE rowid=window.rowid AND memory_items_fts MATCH 'synthetic') FROM window ORDER BY memory_id`;
      assert.isTrue(plan.some((row) => row.detail.includes("MATERIALIZE window")));
      assert.isTrue(plan.some((row) => row.detail.includes("SEARCH memory_items USING")));
      assert.isTrue(
        plan.some((row) => row.detail.includes("VIRTUAL TABLE INDEX") && row.detail.includes("=")),
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("keeps the first unreturned match after the byte cap", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      if (op.kind === "forget") throw new Error("Fixture kind");
      const large = { ...op, payload: { ...op.payload, text: "synthetic " + "x".repeat(15000) } };
      yield* store.apply(decision(large));
      for (const n of [100, 101, 102, 103]) {
        const second = M.MemoryId.make(id(n));
        yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation)
          SELECT space,${second},scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,json_set(item_json,'$.memoryId',${second},'$.revision.memoryId',${second}),availability_json,generation FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
      }
      const first = yield* store.search(
        { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
        "synthetic",
        "substring",
      );
      assert.isTrue(first.items.length > 0 && first.items.length < 5);
      assert.strictEqual(first.examinedAfterMemoryId, first.items.at(-1)!.memoryId);
      assert.isFalse(first.exhausted);
      const wire = yield* Schema.encodeEffect(Schema.fromJsonString(M.MemoryPage))({
        items: first.items,
        nextCursor: first.examinedAfterMemoryId,
        projectionWatermark: 0,
      });
      assert.isTrue(new TextEncoder().encode(wire).length <= M.MEMORY_PAGE_MAX_UTF8_BYTES);
      const next = yield* store.search(
        {
          memorySpaceId: space,
          scope: { kind: "user" },
          limit: 100,
          afterMemoryId: first.examinedAfterMemoryId!,
        },
        "synthetic",
        "substring",
      );
      assert.deepStrictEqual(
        [...first.items, ...next.items].map((i) => i.memoryId),
        [memory, ...[100, 101, 102, 103].map((n) => M.MemoryId.make(id(n)))],
      );
      assert.isTrue(next.exhausted);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "maintains scoped counters through index/hold/scope/delete and transaction rollback",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const filter = { memorySpaceId: space, scope: { kind: "user" as const }, limit: 100 };
        const op = operation();
        if (op.kind === "forget") throw new Error("Fixture kind");
        yield* store.apply(decision(op));
        const initial = yield* store.searchCoverage(filter);
        assert.deepStrictEqual(initial, {
          ready: true,
          eligible: 1,
          indexed: 0,
          textBytes: new TextEncoder().encode(op.payload.text).length,
        });
        const item = yield* store.loadAggregate(space, memory);
        yield* store.index({
          memorySpaceId: space,
          memoryId: memory,
          revisionId: op.revision.revisionId,
          generation: item.generation,
        });
        assert.strictEqual((yield* store.searchCoverage(filter)).indexed, 1);
        yield* store
          .transact(
            Effect.gen(function* () {
              yield* sql`UPDATE memory_items SET status='blocked' WHERE space=${space}`;
              return yield* new Store.MemoryStoreConflict({ code: "unavailable" });
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual((yield* store.searchCoverage(filter)).indexed, 1);
        yield* sql`UPDATE memory_items SET scope_key='explicit:fixture' WHERE space=${space}`;
        assert.strictEqual((yield* store.searchCoverage(filter)).eligible, 0);
        yield* sql`UPDATE memory_items SET scope_key='user',status='blocked' WHERE space=${space}`;
        assert.strictEqual((yield* store.searchCoverage(filter)).textBytes, 0);
        yield* sql`UPDATE memory_items SET status='active',generation=generation+1 WHERE space=${space}`;
        assert.strictEqual((yield* store.searchCoverage(filter)).indexed, 0);
        yield* sql`DELETE FROM memory_items WHERE space=${space}`;
        assert.strictEqual((yield* store.searchCoverage(filter)).eligible, 0);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("escapes FTS input and caps pages", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (const limit of [0, 101])
        assert.isTrue(
          (yield* Effect.exit(
            store.search({ memorySpaceId: space, scope: { kind: "user" }, limit }, '" OR *', "fts"),
          ))._tag === "Failure",
        );
      assert.strictEqual(
        (yield* store.search(
          { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
          '" OR *',
          "fts",
        )).items.length,
        0,
      );
      assert.strictEqual(
        (yield* store.search(
          { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
          '홍길동" OR *',
          "fts",
        )).items.length,
        0,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejected unknown forget survives restart and late upsert", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.preserveForgetIntent({
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(99)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: "capacity_exceeded",
        operationDigest: null,
        submissionState: "rejected",
      });
      yield* store.apply({
        ...decision(),
        admission: Store.approvedReplica,
        receipt: {
          operationId: operation().operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 1,
        },
      });
      const second = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const item = (yield* second.loadAggregate(space, memory)).item;
      assert.strictEqual(item?.status, "blocked");
      assert.isTrue(item?.status === "blocked" && item.failureCode === "forget_pending");
      assert.isDefined((yield* second.loadAggregate(space, memory)).revisions[0]?.payload);
      assert.isFalse(item !== undefined && "payload" in item);
      assert.strictEqual((yield* second.pendingForgetIntents(10)).length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("materializes an unbound intent once after checkpoint install", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const op = operation();
      if (op.kind === "forget") return;
      const draft = {
        intentId: "fixture-local",
        environmentId: env,
        memoryId: M.MemoryId.make(id(70)),
        scope: op.revision.scope,
        provenance: op.revision.provenance,
        assertionKind: op.revision.assertionKind,
        createdAtUtc: now,
        payload: op.payload,
      };
      yield* store.putLocalIntent(draft);
      const input = {
        environmentId: env,
        intentId: draft.intentId,
        memorySpaceId: space,
        operationId: M.MemoryOperationId.make(id(71)),
        revisionId: M.MemoryRevisionId.make(id(72)),
      };
      assert.isTrue((yield* Effect.exit(store.materializeLocalIntent(input)))._tag === "Failure");
      yield* beginFixtureCheckpoint;
      yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() });
      yield* store.completeCheckpoint({
        ...fixtureCheckpointIdentity,
        memorySpaceId: space,
        hubEnvironmentId: env,
        checkpointId: "fixture",
        pageCount: 1,
      });
      const first = yield* store.materializeLocalIntent(input);
      const second = yield* store.materializeLocalIntent({
        ...input,
        operationId: M.MemoryOperationId.make(id(73)),
        revisionId: M.MemoryRevisionId.make(id(74)),
      });
      assert.deepStrictEqual(first, second);
      assert.strictEqual((yield* store.loadAggregate(space, draft.memoryId)).revisions.length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "reserves source exclusions when an identity arrives through checkpoint bootstrap",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const original = checkpoint();
        const pair = original.revisions[0]!;
        const item = original.items[0]!;
        if (item.status !== "active" || !pair.payload) throw new Error("Fixture kind");
        const sourceThread = { environmentId: env, threadId: M.ThreadId.make("thread") };
        const sourceWatermark = {
          fromEventId: M.EventId.make(id(900)),
          toEventId: M.EventId.make(id(901)),
          throughSequence: 1,
        };
        const revision = {
          ...pair.revision,
          provenance: { environmentId: env, sourceThread, sourceWatermark },
        };
        const payload = {
          ...pair.payload,
          evidence: [
            {
              origin: "thread" as const,
              sourceThread,
              watermark: sourceWatermark,
              messageIds: [M.MessageId.make("a"), M.MessageId.make("b")],
            },
          ],
        };
        const page = {
          ...original,
          revisions: [{ revision, payload }],
          items: [{ ...item, revision, payload }],
        };
        yield* beginFixtureCheckpoint;
        yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page });
        yield* store.completeCheckpoint({
          ...fixtureCheckpointIdentity,
          memorySpaceId: space,
          hubEnvironmentId: env,
          checkpointId: "fixture",
          pageCount: 1,
        });
        assert.strictEqual((yield* store.readForgetReservation(space, memory)).keys, 2);
        assert.strictEqual((yield* store.usage(space, { kind: "user" })).keys, 3);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("partial checkpoint stays invisible and forget purges staged bodies", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* beginFixtureCheckpoint;
      yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() });
      assert.isUndefined((yield* store.loadAggregate(space, memory)).item);
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      yield* store.completeCheckpoint({
        ...fixtureCheckpointIdentity,
        memorySpaceId: space,
        hubEnvironmentId: env,
        checkpointId: "fixture",
        pageCount: 1,
      });
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "forgotten");
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("unions 101 suppressed source keys across bounded forget fragments", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (const [ordinal, count] of [
        [0, 100],
        [1, 1],
      ] as const) {
        const operationId = M.MemoryOperationId.make(id(100 + ordinal));
        const op = decodeOperation({
          protocolVersion: 1,
          memorySpaceId: space,
          memoryId: memory,
          operationId,
          originEnvironmentId: env,
          expectedHeads: [],
          kind: "forget",
          tombstone: {
            memorySpaceId: space,
            memoryId: memory,
            deleteOperationId: operationId,
            deletingEnvironmentId: env,
            deletedAtUtc: now,
            suppressedSourceKeys: Array.from({ length: count }, (_, n) => ({
              environmentId: env,
              sourceId: id(200),
              sourceItemKey: `key:${ordinal}:${n}`,
            })),
            suppressedContent: [],
            sourceExclusions: [],
          },
        });
        yield* store.apply(decision(op));
        yield* store.apply(decision(op));
      }
      assert.strictEqual((yield* store.readSuppressions(space, memory)).length, 101);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("search excludes only quarantined memory", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      if (op.kind === "forget") return;
      yield* store.apply(decision(op));
      const current = yield* store.loadAggregate(space, memory);
      yield* store.index({
        memorySpaceId: space,
        memoryId: memory,
        revisionId: op.revision.revisionId,
        generation: current.generation,
      });
      const other = M.MemoryId.make(id(90));
      yield* sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},${other},'{}','user','[]','quarantined',0,'{}','{}')`;
      const results = yield* store.search(
        { memorySpaceId: space, scope: { kind: "user" }, limit: 100 },
        "synthetic",
        "fts",
      );
      assert.deepStrictEqual(
        results.items.map((item) => item.memoryId),
        [memory],
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("encodes worst-case compact receipts and guards within the binary budget", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const base = checkpoint().compactReceipts[0]!;
      const record = M.MemoryCompactReceipt.make({
        ...base,
        operationKind: "resolve",
        resolutionId: M.MemoryResolutionId.make(id(10)),
        attemptId: M.MemoryOperationId.make(id(11)),
        fencingToken: Number.MAX_SAFE_INTEGER,
        receipt: {
          ...base.receipt,
          hubSequence: Number.MAX_SAFE_INTEGER,
          resolutionApproval: {
            resolutionId: M.MemoryResolutionId.make(id(10)),
            appliedAtUtc: now,
            revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-11-13T00:00:00.000Z"),
          },
        },
        reportGuard: {
          reportId: "b".repeat(64),
          resolvingEnvironmentId: env,
          resolutionId: M.MemoryResolutionId.make(id(10)),
          outcome: "resolved",
        },
      });
      const encoded = Store.encodeCompactReceipt(record, () => Number.MAX_SAFE_INTEGER);
      assert.isAtMost(encoded.length, M.MEMORY_COMPACT_RECEIPT_MAX_BYTES);
      yield* store.persistCompactReceipt(record);
      const restored = yield* store.receipt(space, record.receipt.operationId);
      assert.deepStrictEqual(restored?.receipt, record.receipt);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("pending forget holds scanner and conflicting claim candidates after restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.preserveForgetIntent({
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(91)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: "capacity_exceeded",
        operationDigest: null,
        submissionState: "rejected",
      });
      const op = operation();
      if (op.kind === "forget") return;
      yield* store.apply({
        ...decision(op),
        admission: Store.approvedReplica,
        receipt: {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: hash,
          outcome: "accepted",
          hubSequence: 1,
        },
      });
      const pending = yield* store.readDeferred(0, 256);
      const scanner = pending.find((d) => d.kind === "scanner")!;
      yield* store.finishDeferred(scanner, { now: 0, scannerPolicyVersion: 1 });
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "blocked");
      yield* store.recoverClaimCandidates(0);
      assert.deepStrictEqual(yield* store.readDueClaimCandidates(256, 0, space), []);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("derived purge failure remains fenced and recovers after restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      if (op.kind === "forget") return;
      yield* store.apply(decision(op));
      const before = yield* store.loadAggregate(space, memory);
      yield* store.index({
        memorySpaceId: space,
        memoryId: memory,
        revisionId: op.revision.revisionId,
        generation: before.generation,
      });
      yield* sql`ALTER TABLE memory_items_fts RENAME TO unavailable_fts_fixture`;
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      const restored = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.strictEqual(
        (yield* restored.loadAggregate(space, memory)).item?.localAvailability.cleanupPending,
        true,
      );
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      yield* sql`ALTER TABLE unavailable_fts_fixture RENAME TO memory_items_fts`;
      assert.strictEqual(yield* restored.cleanupDerived(256), 1);
      assert.strictEqual((yield* sql`SELECT * FROM memory_items_fts`).length, 0);
      assert.strictEqual(
        (yield* restored.loadAggregate(space, memory)).item?.localAvailability.cleanupPending,
        false,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "reconnects after restart without changing receipt, event, cursor or canonical payload",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const original = yield* store.withReceivedCursor(
          { memorySpaceId: space, hubEnvironmentId: env, expectedSequence: 0, afterSequence: 2 },
          store.apply(parked()),
        );
        const replay = yield* store.apply(reconnected());
        assert.deepStrictEqual(replay, original);
        assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
        yield* store.apply(approved());
        const before = yield* sql`SELECT * FROM memory_events ORDER BY sequence`;
        const bodies =
          yield* sql`SELECT payload_ref,body_json FROM memory_payloads ORDER BY payload_ref`;
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        const generation = (yield* fresh.loadAggregate(space, memory)).generation;
        assert.deepStrictEqual(yield* fresh.reconnectParked(reconnected(), generation), original);
        const after = yield* fresh.loadAggregate(space, memory);
        assert.deepStrictEqual(after.heads, [M.MemoryRevisionId.make(id(14))]);
        assert.strictEqual(after.generation, generation + 1);
        assert.isFalse(after.item?.localAvailability.reasons.includes("missing_parent"));
        assert.isTrue(after.item?.localAvailability.reasons.includes("scanner_pending"));
        assert.strictEqual((yield* fresh.pendingReceived(space, 10)).length, 0);
        assert.deepStrictEqual(yield* sql`SELECT * FROM memory_events ORDER BY sequence`, before);
        assert.deepStrictEqual(
          yield* sql`SELECT payload_ref,body_json FROM memory_payloads ORDER BY payload_ref`,
          bodies,
        );
        assert.strictEqual(yield* fresh.readCursor(space, env), 2);
        assert.deepStrictEqual(yield* fresh.reconnectParked(reconnected(), generation), original);
        assert.strictEqual((yield* fresh.loadAggregate(space, memory)).generation, generation + 1);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rolls back reconnect projection and marker at each SQL failure", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const before = yield* store.loadAggregate(space, memory);
      for (const [table, action] of [
        ["memory_items", "UPDATE"],
        ["memory_inbox_pending", "DELETE"],
      ]) {
        yield* sql.unsafe(
          `CREATE TRIGGER fail_reconnect BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture'); END`,
        );
        assert.strictEqual(
          (yield* Effect.exit(store.reconnectParked(reconnected(), before.generation)))._tag,
          "Failure",
        );
        assert.deepStrictEqual(yield* store.loadAggregate(space, memory), before);
        assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
        yield* sql`DROP TRIGGER fail_reconnect`;
      }
      yield* store.reconnectParked(reconnected(), before.generation);
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("fences stale reconnect decisions and missing parents", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      assert.strictEqual(
        (yield* Effect.exit(store.reconnectParked(reconnected(), generation)))._tag,
        "Failure",
      );
      yield* store.apply(approved());
      assert.strictEqual(
        (yield* Effect.exit(store.reconnectParked(reconnected(), generation)))._tag,
        "Failure",
      );
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejects reconnect with changed operation, digest, receipt or admission", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      const base = reconnected();
      const op = base.operation;
      if (op.kind === "forget") throw new Error("Fixture kind");
      for (const changed of [
        { ...base, operationDigest: "b".repeat(64) },
        { ...base, operation: { ...op, payload: { ...op.payload, text: "changed" } } },
        { ...base, receipt: { ...base.receipt, hubSequence: 99 } },
        { ...base, admission: Store.localIntent },
      ])
        assert.strictEqual(
          (yield* Effect.exit(store.reconnectParked(changed, generation)))._tag,
          "Failure",
        );
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("updates remaining missing parents atomically without rewriting receipt", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const original = yield* store.apply(parked());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      assert.deepStrictEqual(yield* store.reconnectParked(parked(), generation), original);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).generation, generation + 1);
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("reconstructs parked operations from pending metadata after event compaction", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* sql`DELETE FROM memory_events`;
      assert.deepStrictEqual(yield* store.pendingReceived(space, 10), [childOperation()]);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("returns retained ancestry and real missing parents without a boundary", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(approved());
      const parent = M.MemoryRevisionId.make(id(13));
      const absent = M.MemoryRevisionId.make(id(99));
      assert.deepStrictEqual(yield* store.readAncestry(space, memory, [parent, absent]), {
        causalBoundary: undefined,
        retentionFloor: 0,
        parents: [
          { revisionId: parent, status: "retained", parents: [] },
          { revisionId: absent, status: "missing" },
        ],
      });
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "distinguishes checkpoint-covered compacted ancestry from arbitrary unknown UUIDs",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const page = checkpoint();
        yield* beginFixtureCheckpoint;
        yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page });
        yield* store.completeCheckpoint({
          ...fixtureCheckpointIdentity,
          memorySpaceId: space,
          hubEnvironmentId: env,
          checkpointId: "fixture",
          pageCount: 1,
        });
        yield* sql`DELETE FROM memory_revisions`;
        const parent = page.revisions[0]!.revision.revisionId;
        const absent = M.MemoryRevisionId.make(id(99));
        const result = yield* store.readAncestry(space, memory, [parent, absent]);
        assert.deepStrictEqual(result.causalBoundary, page.causalBoundary);
        assert.deepStrictEqual(result.parents, [
          { revisionId: parent, status: "compacted", boundary: page.causalBoundary },
          { revisionId: absent, status: "missing" },
        ]);
        const other = yield* store.readAncestry(space, M.MemoryId.make(id(88)), [parent]);
        assert.deepStrictEqual(other.parents, [
          { revisionId: parent, status: "crossMemory", memoryId: memory },
        ]);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("never treats a staged boundary or a newer compact receipt as covered ancestry", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const page = checkpoint();
      yield* beginFixtureCheckpoint;
      yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page });
      assert.isUndefined((yield* store.readAncestry(space, memory, [])).causalBoundary);
      yield* store.persistCompactReceipt({
        ...page.compactReceipts[0]!,
        receipt: { ...page.compactReceipts[0]!.receipt, hubSequence: 2 },
      });
      yield* sql`INSERT INTO memory_compaction_state (space,boundary_json,published) VALUES (${space},${JSON.stringify(page.causalBoundary)},1)`;
      assert.strictEqual(
        (yield* store.readAncestry(space, memory, [page.revisions[0]!.revision.revisionId]))
          .parents[0]?.status,
        "missing",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejects a retained cross-memory parent before reconnect", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const other = M.MemoryId.make(id(88));
      yield* sql`UPDATE memory_revisions SET memory_id=${other} WHERE revision_id=${M.MemoryRevisionId.make(id(13))}`;
      assert.strictEqual(
        (yield* store.readAncestry(space, memory, [M.MemoryRevisionId.make(id(13))])).parents[0]
          ?.status,
        "crossMemory",
      );
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      assert.strictEqual(
        (yield* Effect.exit(store.reconnectParked(reconnected(), generation)))._tag,
        "Failure",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("serializes concurrent reconnects into one projection update", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      yield* store.apply(approved());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      const results = yield* Effect.all(
        [
          store.reconnectParked(reconnected(), generation),
          store.reconnectParked(reconnected(), generation),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(results[0], results[1]);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).generation, generation + 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("reconnect preserves a pending forget exposure fence", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      yield* store.apply(approved());
      yield* store.preserveForgetIntent({
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(90)),
        requestedAtUtc: now,
        attempts: 0,
        lastFailureCode: "capacity_exceeded",
        operationDigest: null,
        submissionState: "rejected",
      });
      yield* store.reconnectParked(
        reconnected(),
        (yield* store.loadAggregate(space, memory)).generation,
      );
      const item = (yield* store.loadAggregate(space, memory)).item;
      assert.strictEqual(item?.status, "blocked");
      assert.isTrue(item?.status === "blocked" && item.failureCode === "forget_pending");
      assert.isFalse(item !== undefined && "payload" in item);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("forget wins over late reconnect without restoring a body", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const original = yield* store.apply(parked());
      yield* store.apply(approved());
      const generation = (yield* store.loadAggregate(space, memory)).generation;
      const forget = decodeOperation({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(50),
        originEnvironmentId: env,
        expectedHeads: [],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(50),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.apply(decision(forget));
      assert.deepStrictEqual(yield* store.reconnectParked(reconnected(), generation), original);
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "forgotten");
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 0);
      assert.strictEqual((yield* store.pendingReceived(space, 10)).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("reports an unlinked parked parent separately from a retained DAG ancestor", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(parked());
      const revisionId = M.MemoryRevisionId.make(id(14));
      assert.deepStrictEqual((yield* store.readAncestry(space, memory, [revisionId])).parents, [
        { revisionId, status: "parked", missingParents: [M.MemoryRevisionId.make(id(13))] },
      ]);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("reads work and persists a claimed retry across restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      assert.isUndefined(yield* store.readWork("absent"));
      const work = backgroundWork();
      yield* store.enqueueWork(work);
      assert.isTrue(yield* store.claimWork(work.id, "runtime-a", 0, 100));
      const claimed = (yield* store.readWork(work.id))!;
      assert.isTrue(yield* store.retryWork(claimed, 5000));
      assert.isFalse(yield* store.retryWork(claimed, 1));
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.dueWork(4999, 100), []);
      const due = yield* fresh.dueWork(5000, 100);
      assert.strictEqual(due[0]?.status, "retry");
      assert.strictEqual(due[0]?.attempt, 1);
      assert.isNull(due[0]?.claimedBy);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("stale worker cannot postpone a reclaimed or terminal row", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = backgroundWork();
      yield* store.enqueueWork(work);
      yield* store.claimWork(work.id, "runtime-a", 0, 100);
      const stale = (yield* store.readWork(work.id))!;
      yield* store.claimWork(work.id, "runtime-b", 100, 200);
      assert.isFalse(yield* store.retryWork(stale, 5000));
      const current = (yield* store.readWork(work.id))!;
      yield* store.finishWork(work.id, "completed");
      assert.isFalse(yield* store.retryWork(current, 5000));
      assert.strictEqual((yield* store.readWork(work.id))?.status, "completed");
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("commits thread hook watermark and work atomically and recovers after restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = backgroundWork();
      assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
      yield* store.commitThreadHook({ expectedWatermark: 0, throughWatermark: 7, work: [work] });
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.strictEqual(yield* fresh.readThreadHookWatermark(), 7);
      assert.deepStrictEqual(yield* fresh.readWork(work.id), work);
      assert.deepStrictEqual(
        (yield* fresh.dueWork(0, 100)).map((row) => row.id),
        [work.id],
      );
      assert.strictEqual(
        (yield* Effect.exit(
          fresh.commitThreadHook({
            expectedWatermark: 0,
            throughWatermark: 8,
            work: [backgroundWork("stale")],
          }),
        ))._tag,
        "Failure",
      );
      assert.isUndefined(yield* fresh.readWork("stale"));
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rolls back enqueued hook work if watermark storage fails", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_hook BEFORE INSERT ON memory_outbox WHEN NEW.id='memory:thread-hook:v1' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
      assert.strictEqual(
        (yield* Effect.exit(
          store.commitThreadHook({
            expectedWatermark: 0,
            throughWatermark: 7,
            work: [backgroundWork()],
          }),
        ))._tag,
        "Failure",
      );
      assert.isUndefined(yield* store.readWork(backgroundWork().id));
      assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "fences concurrent hook sweeps and rejects watermark rollback or marker overwrite",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const results = yield* Effect.all(
          [
            Effect.exit(
              store.commitThreadHook({
                expectedWatermark: 0,
                throughWatermark: 1,
                work: [backgroundWork("one")],
              }),
            ),
            Effect.exit(
              store.commitThreadHook({
                expectedWatermark: 0,
                throughWatermark: 2,
                work: [backgroundWork("two")],
              }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(results.filter((result) => result._tag === "Success").length, 1);
        const current = yield* store.readThreadHookWatermark();
        assert.strictEqual(
          (yield* Effect.exit(
            store.commitThreadHook({ expectedWatermark: current, throughWatermark: 0, work: [] }),
          ))._tag,
          "Failure",
        );
        assert.strictEqual(
          (yield* Effect.exit(
            store.commitThreadHook({
              expectedWatermark: current,
              throughWatermark: current + 1,
              work: [backgroundWork("memory:thread-hook:v1")],
            }),
          ))._tag,
          "Failure",
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("caps generic worker sweeps at 100 rows", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (let n = 0; n < 101; n++) yield* store.enqueueWork(backgroundWork(`fixture:${n}`));
      assert.strictEqual((yield* store.dueWork(0, 256)).length, 100);
      assert.strictEqual((yield* store.dueWork(0, -1)).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("limits runnable deferred rows after excluding held, future and claimed work", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* seedDeferred(80, [
        deferredWork("parent", { state: "held" }),
        deferredWork("scanner", { claimedBy: "other", claimedUntil: 100 }),
        deferredWork("index", { dueAt: 100 }),
      ]);
      yield* seedDeferred(81, [deferredWork("index")]);
      assert.deepStrictEqual(
        (yield* store.readDeferred(0, 1)).map((row) => row.memoryId),
        [M.MemoryId.make(id(81))],
      );
      assert.strictEqual((yield* store.readDeferred(0, -1)).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "orders deferred rows by due, null-first last attempt, memory and kind across restart",
    () =>
      Effect.gen(function* () {
        yield* seedDeferred(80, [deferredWork("index", { lastAttemptAt: 10 })]);
        yield* seedDeferred(81, [deferredWork("scanner"), deferredWork("index")]);
        yield* seedDeferred(82, [deferredWork("parent", { dueAt: 1 })]);
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(
          (yield* fresh.readDeferred(1, 3)).map((row) => [row.memoryId, row.kind]),
          [
            [M.MemoryId.make(id(81)), "index"],
            [M.MemoryId.make(id(81)), "scanner"],
            [M.MemoryId.make(id(80)), "index"],
          ],
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("charges index payloads independently of unrelated history", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* seedDeferred(
        80,
        [deferredWork("index"), deferredWork("scanner")],
        M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      );
      const rows = yield* store.readDeferred(0, 10);
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows.find((row) => row.kind === "index")!.payloadBytes, 0);
      assert.strictEqual(
        rows.find((row) => row.kind === "scanner")!.payloadBytes,
        Math.min(
          M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS * M.MEMORY_PAYLOAD_MAX_UTF8_BYTES,
        ),
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("advances an approved scanner with over 8 MiB history across restart", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(approved());
      const payload = yield* encodePayload({
        text: "x".repeat(16000),
        evidence: [],
        derivedFromMemoryRevisions: [],
      });
      for (let index = 0; index < 600; index++) {
        yield* sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${id(1000 + index)},${memory},${payload},'[]')`;
      }
      assert.isAbove(
        (yield* store.usage(space, { kind: "user" })).historyBytes,
        M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      );
      const first = (yield* store.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
      assert.isDefined(first);
      assert.isTrue(yield* store.claimDeferred(first, "owner", 0, 1000));
      const chunk = yield* store.readScannerChunk(first);
      assert.strictEqual(chunk.payloads.length, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isNotNull(chunk.nextCursor);
      assert.strictEqual(scanMemoryValue({ payloads: chunk.payloads }).kind, "allowed");
      assert.isTrue(
        yield* store.finishOwnedDeferred(first, "owner", 1000, {
          now: 0,
          scannerCursor: chunk.nextCursor!,
        }),
      );
      assert.include(
        (yield* store.loadAggregate(space, memory)).item!.localAvailability.reasons,
        "scanner_pending",
      );
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const second = (yield* fresh.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
      assert.strictEqual(second.scannerCursor, chunk.nextCursor);
      assert.isFalse(yield* fresh.claimDeferred(first, "stale", 0, 1000));
      assert.isTrue(yield* fresh.claimDeferred(second, "owner", 0, 1000));
      const rest = yield* fresh.readScannerChunk(second);
      assert.strictEqual(rest.payloads.length, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isNotNull(rest.nextCursor);
      assert.isTrue(
        yield* fresh.finishOwnedDeferred(second, "owner", 1000, {
          now: 0,
          scannerCursor: rest.nextCursor!,
        }),
      );
      const third = (yield* fresh.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
      assert.strictEqual(third.scannerCursor, rest.nextCursor);
      assert.isTrue(yield* fresh.claimDeferred(third, "owner", 0, 1000));
      const tail = yield* fresh.readScannerChunk(third);
      assert.strictEqual(tail.payloads.length, 601 - 2 * M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS);
      assert.isNull(tail.nextCursor);
      assert.isTrue(
        yield* fresh.finishOwnedDeferred(third, "owner", 1000, {
          now: 0,
          scannerPolicyVersion: 1,
        }),
      );
      assert.notInclude(
        (yield* fresh.loadAggregate(space, memory)).item!.localAvailability.reasons,
        "scanner_pending",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "recovers only eligible held rows in bounded batches and leaves idle items untouched",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* seedDeferred(1000, [deferredWork("scanner")]);
        yield* seedDeferred(2000, [deferredWork("index", { state: "held", reason: "fts_braked" })]);
        yield* store.putFtsState({ ...(yield* store.ftsState(env)), state: "braked" });
        for (let index = 1; index <= M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1; index++) {
          yield* seedDeferred(1000 + index, [
            deferredWork("scanner", {
              state: "held",
              reason: "secret_detected",
              scannerCursor: "old-policy-cursor",
            }),
          ]);
        }
        yield* sql`CREATE TABLE recovery_updates (memory_id TEXT)`;
        yield* sql`CREATE TRIGGER count_recovery AFTER UPDATE ON memory_items BEGIN INSERT INTO recovery_updates VALUES (NEW.memory_id); END`;
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
        );
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1,
        );
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1,
        );
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates WHERE memory_id IN (${id(1000)},${id(2000)})`)
            .length,
          0,
        );
        const resumed = (yield* store.readDeferred(0, 100)).find(
          (row) => row.memoryId === id(1001),
        )!;
        assert.isUndefined(resumed.scannerCursor);
        yield* store.putFtsState({ ...(yield* store.ftsState(env)), state: "open" });
        yield* store.recoverDeferred(1, 0);
        assert.strictEqual(
          (yield* sql`SELECT * FROM recovery_updates`).length,
          M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 2,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("recovers global parked work with bounded pages after event compaction", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(parked());
      yield* sql`DELETE FROM memory_events`;
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.readParked(1), [childOperation()]);
      assert.deepStrictEqual(yield* fresh.readParked(0), []);
      assert.deepStrictEqual(yield* fresh.readParked(-1), []);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "cancels future and running thread jobs without crossing environment or terminal boundaries",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        yield* store.enqueueWork(summaryWork(1));
        yield* store.enqueueWork({ ...summaryWork(2), kind: "consolidate", nextAttemptAt: 10000 });
        yield* store.enqueueWork(summaryWork(3));
        yield* store.claimWork(summaryWork(3).id, "runtime", 0, 100);
        yield* store.enqueueWork({ ...summaryWork(4), status: "completed" });
        yield* store.enqueueWork(summaryWork(5, M.EnvironmentId.make("other")));
        const thread = { environmentId: env, threadId: M.ThreadId.make(id(70)) };
        assert.strictEqual(yield* store.cancelThreadWork(thread), 3);
        assert.strictEqual(yield* store.cancelThreadWork(thread), 0);
        assert.strictEqual((yield* store.readWork(summaryWork(3).id))?.status, "cancelled");
        assert.isNull((yield* store.readWork(summaryWork(3).id))?.claimedBy);
        assert.strictEqual((yield* store.readWork(summaryWork(4).id))?.status, "completed");
        assert.strictEqual((yield* store.readWork(summaryWork(5).id))?.status, "pending");
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "commits a hook summary intent and watermark with rollback on summary insertion failure",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER fail_summary BEFORE INSERT ON memory_outbox WHEN NEW.kind='summary' BEGIN SELECT RAISE(ABORT,'fixture'); END`;
        const input = { expectedWatermark: 0, throughWatermark: 7, work: [summaryWork(7)] };
        assert.strictEqual((yield* Effect.exit(store.commitThreadHook(input)))._tag, "Failure");
        assert.strictEqual(yield* store.readThreadHookWatermark(), 0);
        yield* sql`DROP TRIGGER fail_summary`;
        yield* store.commitThreadHook(input);
        assert.deepStrictEqual(yield* store.readWork(summaryWork(7).id), summaryWork(7));
        assert.strictEqual(yield* store.readThreadHookWatermark(), 7);
      }).pipe(checkUsage, Effect.provide(live)),
  );
});

describe("generation failure ownership", () => {
  const failure = (work: Store.MemoryWork, retryAt: number | null = null) => ({
    work,
    environmentId: env,
    failureCode: "generation_failed" as const,
    now: 1,
    retryAt,
  });
  const claimed = Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    yield* store.enqueueWork({ ...summaryWork(9), space, memoryId: memory });
    yield* store.claimWork("summary:9", "worker", 0, 100);
    return (yield* store.readWork("summary:9"))!;
  });
  it.effect("records one report and terminates atomically", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      assert.isTrue(yield* store.failGenerationAttempt(failure(work)));
      assert.isFalse(yield* store.failGenerationAttempt(failure(work)));
      const reports = yield* store.pendingReports(100);
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0]!.outcome, "failed");
      assert.strictEqual(reports[0]!.failureCode, "generation_failed");
      assert.strictEqual((yield* store.readWork(work.id))!.status, "failed");
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("persists retry due time with the safe report", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      assert.isTrue(yield* store.failGenerationAttempt(failure(work, 5001)));
      assert.strictEqual((yield* store.readWork(work.id))!.nextAttemptAt, 5001);
      assert.strictEqual((yield* store.pendingReports(100)).length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejects stale owners and expired claims without reports", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      assert.isFalse(yield* store.failGenerationAttempt(failure({ ...work, claimedBy: "other" })));
      assert.isFalse(yield* store.failGenerationAttempt({ ...failure(work), now: 100 }));
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejects foreign environment authority", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      const result = yield* store
        .failGenerationAttempt({ ...failure(work), environmentId: M.EnvironmentId.make("foreign") })
        .pipe(Effect.flip);
      assert.strictEqual(result._tag, "MemoryStoreConflict");
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rolls back report and retry together", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const work = yield* claimed;
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.failGenerationAttempt(failure(work, 5001));
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
      assert.strictEqual((yield* store.readWork(work.id))!.status, "running");
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

describe("unbound summary replacement", () => {
  const draft = (watermark: number): Store.LocalMemoryIntent => ({
    intentId: "summary-draft",
    environmentId: env,
    memoryId: memory,
    scope: { kind: "thread", thread: { environmentId: env, threadId: M.ThreadId.make("thread") } },
    assertionKind: "inference",
    createdAtUtc: now,
    provenance: {
      environmentId: env,
      sourceThread: { environmentId: env, threadId: M.ThreadId.make("thread") },
      sourceWatermark: {
        fromEventId: M.EventId.make("first"),
        toEventId: M.EventId.make("last"),
        throughSequence: watermark,
      },
    },
    payload: {
      text: `synthetic summary ${watermark}`,
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  });
  it.effect("replaces only with a newer committed watermark", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.refreshLocalSummaryIntent(draft(1));
      yield* store.refreshLocalSummaryIntent(draft(2));
      yield* store.refreshLocalSummaryIntent(draft(1));
      const work = yield* store.readWork("local:fixture:summary-draft");
      assert.strictEqual(work?.metadata.kind, "localIntent");
      if (work?.metadata.kind === "localIntent")
        assert.strictEqual(work.metadata.provenance.sourceWatermark?.throughSequence, 2);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("cannot resurrect a forgotten local draft", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.refreshLocalSummaryIntent(draft(1));
      yield* store.forgetLocalIntent(env, "summary-draft");
      const result = yield* store.refreshLocalSummaryIntent(draft(2)).pipe(Effect.flip);
      assert.strictEqual(result._tag, "MemoryStoreConflict");
      if (result._tag === "MemoryStoreConflict") assert.strictEqual(result.code, "forgotten");
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

describe("derived work integration", () => {
  it.effect("active writes durably schedule a generation-fenced index repair", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      const rows = yield* store.readDeferred(0, 100);
      assert.isTrue(
        rows.some((r) => r.kind === "index" && r.memoryId === memory && r.generation === 1),
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("local draft admin rows cannot starve generic work", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({ ...backgroundWork("a-admin"), kind: "admin" });
      yield* store.enqueueWork(backgroundWork("z-index"));
      assert.deepStrictEqual(
        (yield* store.dueWork(0, 1)).map((w) => w.id),
        ["z-index"],
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("pending sync clears after durable acknowledgement", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const op = operation();
      yield* store.apply(decision(op));
      assert.isTrue((yield* store.loadAggregate(space, memory)).item!.pendingSync);
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, {
        operationId: op.operationId,
        memoryId: memory,
        operationDigest: hash,
        hubSequence: 1,
        outcome: "accepted",
      });
      assert.isFalse((yield* store.loadAggregate(space, memory)).item!.pendingSync);
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

describe("worker completion fencing", () => {
  it.effect("rejects a deferred completion from an old owner", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision());
      const target = (yield* store.readDeferred(0, 100))[0]!;
      yield* store.claimDeferred(target, "new-owner", 0, Number.MAX_SAFE_INTEGER);
      assert.isFalse(
        yield* store.finishOwnedDeferred(target, "old-owner", Number.MAX_SAFE_INTEGER, { now: 1 }),
      );
      assert.strictEqual((yield* store.readDeferred(0, 100)).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("compacts older completed summary rows without dropping the latest receipt", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({ ...summaryWork(9), status: "completed" });
      yield* store.enqueueWork(summaryWork(10));
      yield* store.claimWork("summary:10", "worker", 0, Number.MAX_SAFE_INTEGER);
      const work = (yield* store.readWork("summary:10"))!;
      assert.isTrue(yield* store.completeSummaryWork(work));
      assert.isUndefined(yield* store.readWork("summary:9"));
      assert.strictEqual((yield* store.readWork("summary:10"))!.status, "completed");
      assert.isFalse(yield* store.completeSummaryWork(work));
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rolls back summary completion and receipt compaction together", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.enqueueWork({ ...summaryWork(9), status: "completed" });
      yield* store.enqueueWork(summaryWork(10));
      yield* store.claimWork("summary:10", "worker", 0, Number.MAX_SAFE_INTEGER);
      const work = (yield* store.readWork("summary:10"))!;
      yield* store
        .transact(
          store
            .completeSummaryWork(work)
            .pipe(
              Effect.andThen(
                Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
              ),
            ),
        )
        .pipe(Effect.flip);
      assert.isDefined(yield* store.readWork("summary:9"));
      assert.strictEqual((yield* store.readWork("summary:10"))!.status, "running");
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

it("measures the versioned compact maximum and preserves approval and correlation fields", () => {
  const record = M.MemoryCompactReceipt.make({
    memorySpaceId: space,
    originEnvironmentId: env,
    operationKind: "resolve",
    receipt: {
      operationId: M.MemoryOperationId.make(id(3)),
      memoryId: memory,
      operationDigest: hash,
      outcome: "accepted",
      hubSequence: Number.MAX_SAFE_INTEGER,
      resolutionApproval: {
        resolutionId: M.MemoryResolutionId.make(id(7)),
        appliedAtUtc: M.MemoryUtcTimestamp.make("+275760-08-13T00:00:00.000Z"),
        revertDeadlineUtc: M.MemoryUtcTimestamp.make("+275760-09-12T00:00:00.000Z"),
      },
      forgetExpansion: {
        requestDigest: hash,
        operationId: M.MemoryOperationId.make(id(8)),
        operationDigest: hash,
        status: "pending",
      },
      forgetRetryOf: { operationId: M.MemoryOperationId.make(id(9)), operationDigest: hash },
    },
    revisionId: M.MemoryRevisionId.make(id(4)),
    resolutionId: M.MemoryResolutionId.make(id(7)),
    revertsResolutionId: null,
    attemptId: M.MemoryOperationId.make(id(5)),
    fencingToken: Number.MAX_SAFE_INTEGER,
    reportGuard: {
      reportId: hash,
      resolvingEnvironmentId: env,
      resolutionId: M.MemoryResolutionId.make(id(7)),
      outcome: "resolved",
    },
  });
  const bytes = Store.encodeCompactReceipt(record, () => Number.MAX_SAFE_INTEGER);
  assert.strictEqual(bytes.length, M.MEMORY_COMPACT_RECEIPT_ENCODING_MAX_BYTES);
  assert.strictEqual(
    bytes.length + M.MEMORY_COMPACT_RECEIPT_HEADROOM_BYTES,
    M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
  );
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(bytes, space, () => env),
    record,
  );
  const rejected = M.MemoryCompactReceipt.make({
    ...record,
    revisionId: null,
    reportGuard: null,
    receipt: {
      operationId: record.receipt.operationId,
      memoryId: memory,
      operationDigest: hash,
      hubSequence: Number.MAX_SAFE_INTEGER,
      outcome: "rejected",
      failureCode: "capacity_exceeded",
      capacity: {
        code: "capacity_exceeded",
        dimension: "live_payload_bytes",
        current: Number.MAX_SAFE_INTEGER,
        limit: Number.MAX_SAFE_INTEGER,
        reclaimable: Number.MAX_SAFE_INTEGER,
      },
      forgetExpansion: record.receipt.forgetExpansion!,
      forgetRetryOf: record.receipt.forgetRetryOf!,
    },
  });
  assert.isAtMost(
    Store.encodeCompactReceipt(rejected, () => Number.MAX_SAFE_INTEGER).length,
    bytes.length,
  );
  const op = operation();
  const legacyRecord = M.MemoryCompactReceipt.make({
    memorySpaceId: space,
    originEnvironmentId: env,
    operationKind: "upsert",
    receipt: {
      operationId: op.operationId,
      memoryId: memory,
      operationDigest: hash,
      outcome: "accepted",
      hubSequence: 1,
    },
    revisionId: M.MemoryRevisionId.make(id(13)),
    resolutionId: null,
    revertsResolutionId: null,
    attemptId: null,
    fencingToken: null,
    reportGuard: null,
  });
  const replayRecord = M.MemoryCompactReceipt.make({
    ...legacyRecord,
    upsertRequestDigest: hash,
    revisionId: null,
    receipt: { ...rejected.receipt },
  });
  const replayBytes = Store.encodeCompactReceipt(replayRecord, () => Number.MAX_SAFE_INTEGER);
  assert.isAtMost(replayBytes.length, M.MEMORY_COMPACT_RECEIPT_ENCODING_MAX_BYTES);
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(replayBytes, space, () => env),
    replayRecord,
  );
  const v2 = Store.encodeCompactReceipt(legacyRecord, () => 1);
  const v1 = v2.slice(0, -3);
  v1[0] = 1;
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(v1, space, () => env),
    legacyRecord,
  );
  assert.deepStrictEqual(
    Store.decodeCompactReceipt(v2, space, () => env),
    legacyRecord,
  );
});

it.effect(
  "selects base forget and extension before LIMIT, then preserves retry ownership across restart",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const enqueue = (n: number, kind: "upsert" | "forget") =>
        Effect.gen(function* () {
          const base = operation(n);
          if (base.kind !== "upsert") throw new Error("fixture");
          const op: M.MemoryOperation =
            kind === "upsert"
              ? base
              : {
                  protocolVersion: 1,
                  kind: "forget",
                  memorySpaceId: space,
                  memoryId: memory,
                  operationId: base.operationId,
                  originEnvironmentId: env,
                  expectedHeads: [],
                  tombstone: {
                    memorySpaceId: space,
                    memoryId: memory,
                    deleteOperationId: base.operationId,
                    deletingEnvironmentId: env,
                    deletedAtUtc: M.MemoryUtcTimestamp.make(now),
                    suppressedSourceKeys: [],
                    suppressedContent: [],
                    sourceExclusions: [],
                  },
                };
          const { payload: _payload, ...metadata } =
            kind === "upsert" ? base : { ...op, payload: undefined };
          const workId = `sync:${space}:${op.operationId}`;
          yield* store.enqueueWork({
            id: workId,
            space,
            memoryId: memory,
            kind: "sync",
            status: "pending",
            metadata,
            payloadRef: null,
            attempt: 0,
            nextAttemptAt: 0,
            claimedBy: null,
            claimedUntil: null,
          });
          yield* sql`UPDATE memory_outbox SET operation_digest=${hash} WHERE id=${workId}`;
          return { op, workId };
        });
      for (let n = 100; n < 205; n++) yield* enqueue(n, "upsert");
      const base = yield* enqueue(500, "forget");
      const extension = yield* enqueue(501, "forget");
      const metadata = yield* encodeOperationJson(base.op);
      yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,${space},${memory},${base.op.operationId},'forget',${env},${hash},${metadata},${`{"forgetExpansion":{"operationId":"${extension.op.operationId}"}}`},0)`;
      const due = yield* store.readEligibleOutbox(space, 0, 2);
      assert.deepStrictEqual(
        due.map((c) => c.work.id),
        [base.workId, extension.workId],
      );
      // The actual immutable forget bytes must match the ownership digest.
      const original = yield* store.readWorkOperation(base.workId);
      assert.isDefined(original);
      const digest = memoryOperationDigest(original!);
      yield* sql`UPDATE memory_outbox SET operation_digest=${digest} WHERE id=${base.workId}`;
      const owner = yield* store.transact(
        store.acquireSyncWorkTx({
          workId: base.workId,
          operationId: base.op.operationId,
          operationDigest: digest,
          owner: "first",
          expectedVersion: 0,
          now: 0,
          ownedUntil: 10,
        }),
      );
      assert.isNotNull(owner);
      const retry = yield* store.transact(
        store.retrySyncWorkTx({
          ownership: owner!,
          now: 1,
          nextAttemptAt: 20,
          failureCode: "source_unavailable",
        }),
      );
      assert.isTrue(retry);
      assert.isFalse(
        yield* store.transact(
          store.retrySyncWorkTx({
            ownership: owner!,
            now: 2,
            nextAttemptAt: 30,
            failureCode: null,
          }),
        ),
      );
      assert.isFalse(
        (yield* store.readEligibleOutbox(space, 19, 2)).some((c) => c.work.id === base.workId),
      );
      const recovered = yield* Effect.gen(function* () {
        const restarted = yield* Store.MemoryStore;
        return yield* restarted.readEligibleOutbox(space, 20, 2);
      }).pipe(Effect.provide(Store.layer));
      assert.strictEqual(recovered[0]?.operationDigest, digest);
      assert.strictEqual(recovered[0]?.work.id, base.workId);
      assert.strictEqual(recovered[0]?.version, 2);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "reserves combined checkpoint bytes at equality and rolls back overflow and failed transactions",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const reserved = yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - 1,
          publishedPinnedDeltaBytes: 1,
        }),
      );
      assert.strictEqual(reserved.stagingBytes, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES);
      const overflow = yield* store
        .transact(
          store.reserveHubCheckpointTx({
            memorySpaceId: space,
            checkpointDeltaBytes: 1,
            publishedPinnedDeltaBytes: 0,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(overflow._tag, "MemoryCapacityError");
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.reserveHubCheckpointTx({
              memorySpaceId: space,
              checkpointDeltaBytes: -10,
              publishedPinnedDeltaBytes: 0,
            });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(
        (yield* store.transact(store.readHubUsageTx(space))).stagingBytes,
        M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "recovers the full frozen claim, ignores a changed default, and retires only the matching generation",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const first = operation();
      if (first.kind !== "upsert") throw new Error("fixture");
      const commit = (op: M.MemoryOperation) =>
        Effect.gen(function* () {
          const current = yield* store.loadAggregate(space, memory);
          yield* store.apply(
            decideMemoryOperation(current, op, Store.hubAdmission, { kind: "allowed" }),
          );
        });
      yield* commit(first);
      const child = (n: number): M.MemoryOperation => {
        const op = operation(n);
        if (op.kind !== "upsert") throw new Error("fixture");
        return {
          ...op,
          expectedHeads: [first.revision.revisionId],
          revision: { ...op.revision, parents: [first.revision.revisionId] },
        };
      };
      yield* commit(child(4));
      yield* commit(child(5));
      yield* store.recoverClaimCandidates(0);
      const candidate = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
      if (candidate.metadata.kind !== "claim") throw new Error("fixture");
      const claim: M.MemoryHubClaimInput = {
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        holderEnvironmentId: env,
        conflictId: candidate.metadata.conflictId,
        conflictHeadSet: candidate.metadata.sortedHeads,
        attemptId: M.MemoryOperationId.make(id(60)),
        frozenDefaultModelSelection: { instanceId: M.ProviderInstanceId.make("P"), model: "P" },
      };
      yield* store.retryClaimCandidate(candidate.id, 100, "lease_required");
      assert.isNull(
        yield* store.transact(
          store.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 0,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: claim,
          }),
        ),
      );
      yield* store.retryClaimCandidate(candidate.id, 0, "lease_required");
      const prepared = yield* store.transact(
        store.prepareClaimAttemptTx({
          memorySpaceId: space,
          candidateId: candidate.id,
          expectedGeneration: 0,
          conflictHeads: claim.conflictHeadSet,
          proposedClaim: claim,
        }),
      );
      assert.deepStrictEqual(prepared, { claim, generation: 0 });
      const changed = {
        ...claim,
        attemptId: M.MemoryOperationId.make(id(61)),
        frozenDefaultModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
      };
      const recovered = yield* Effect.gen(function* () {
        const restarted = yield* Store.MemoryStore;
        return yield* restarted.transact(
          restarted.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 0,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: changed,
          }),
        );
      }).pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(recovered, { claim, generation: 0 });
      const ticket: M.MemoryResolutionLease = {
        memorySpaceId: space,
        memoryId: memory,
        conflictId: claim.conflictId,
        conflictHeadSet: claim.conflictHeadSet,
        holderEnvironmentId: env,
        attemptId: claim.attemptId,
        frozenDefaultModelSelection: claim.frozenDefaultModelSelection,
        fencingToken: 1,
        claimedAtHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
        expiresAtHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:02:00.000Z"),
        attemptDeadlineHubTime: M.MemoryUtcTimestamp.make("1970-01-01T00:10:00.000Z"),
      };
      yield* store.persistResolutionTicket(ticket);
      const key = { memorySpaceId: space, attemptId: claim.attemptId };
      const owned = yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: 0,
          owner: "registry",
          coordinatorEpoch: 1,
          now: 0,
          ownedUntil: 100,
        }),
      );
      assert.isNotNull(owned);
      const ownership = { ...key, owner: "registry", coordinatorEpoch: 1, version: owned!.version };
      assert.isNull(
        yield* store.transact(
          store.transitionResolutionTicketTx({
            ownership,
            nextState: "terminal",
            now: 1,
            ownedUntil: null,
            nextAttemptAt: 1,
            retireClaim: { expectedGeneration: 9, attemptId: claim.attemptId },
          }),
        ),
      );
      assert.isNotNull(
        yield* store.transact(
          store.transitionResolutionTicketTx({
            ownership,
            nextState: "terminal",
            now: 1,
            ownedUntil: null,
            nextAttemptAt: 1,
            retireClaim: { expectedGeneration: 0, attemptId: claim.attemptId },
          }),
        ),
      );
      yield* TestClock.adjust(1);
      const next = yield* store.transact(
        store.prepareClaimAttemptTx({
          memorySpaceId: space,
          candidateId: candidate.id,
          expectedGeneration: 1,
          conflictHeads: changed.conflictHeadSet,
          proposedClaim: changed,
        }),
      );
      assert.deepStrictEqual(next, { claim: changed, generation: 1 });
      assert.isNull(
        yield* store.transact(
          store.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 0,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: claim,
          }),
        ),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

describe("MemoryStore hub administration", () => {
  const record = (
    n: number,
    action: "provisionMember" | "rotateMemberCredential" | "revokeMember",
  ): Store.AdminRecord => ({
    requestId: M.MemoryOperationId.make(id(n)),
    requestDigest: "b".repeat(64),
    expectedVersion: n,
    stage: "prepared",
    action: {
      requestId: M.MemoryOperationId.make(id(n)),
      expectedVersion: n,
      action,
      environmentId: env,
    },
    secretName: action === "revokeMember" ? null : "synthetic-member-key",
    result: null,
    memberVersion: null,
  });
  it.effect("provisions, rotates and revokes with durable replay and stale credential denial", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const first = record(200, "provisionMember");
      yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
      const activation = {
        requestId: first.requestId,
        requestDigest: first.requestDigest,
        memorySpaceId: space,
        environmentId: env,
        expectedCredentialVersion: null,
        next: { credentialDigest: "a".repeat(64) },
        now: 100,
      };
      const member = yield* store.transact(store.activateHubMemberTx(activation));
      assert.strictEqual(member.credentialVersion, 1);
      assert.deepStrictEqual(yield* store.transact(store.activateHubMemberTx(activation)), member);
      const rotate = record(201, "rotateMemberCredential");
      yield* store.transact(store.writeHubAdminTx({ record: rotate, expectedStage: null }));
      yield* store.transact(
        store.activateHubMemberTx({
          ...activation,
          requestId: rotate.requestId,
          expectedCredentialVersion: 1,
          next: { credentialDigest: "c".repeat(64) },
        }),
      );
      assert.isUndefined(yield* store.findHubMemberByCredential("a".repeat(64)));
      assert.strictEqual(
        (yield* store
          .transact(
            store.requireHubMemberTx({
              memorySpaceId: space,
              environmentId: env,
              credentialVersion: 1,
              scopes: ["memory:sync"],
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      const revoke = record(202, "revokeMember");
      yield* store.transact(store.writeHubAdminTx({ record: revoke, expectedStage: null }));
      const revoked = yield* store.transact(
        store.activateHubMemberTx({
          ...activation,
          requestId: revoke.requestId,
          expectedCredentialVersion: 2,
          next: "revoked",
        }),
      );
      assert.strictEqual(revoked.status, "revoked");
      assert.strictEqual(revoked.credentialVersion, 3);
      assert.strictEqual(
        (yield* store.transact(store.readHubAdminTx(revoke.requestId)))?.stage,
        "activated",
      );
      assert.strictEqual((yield* store.readPendingHubAdmins(100)).length, 3);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rolls activation back with the admin stage and rejects changed request reuse", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const first = record(210, "provisionMember");
      yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.activateHubMemberTx({
              requestId: first.requestId,
              requestDigest: first.requestDigest,
              memorySpaceId: space,
              environmentId: env,
              expectedCredentialVersion: null,
              next: { credentialDigest: "a".repeat(64) },
              now: 0,
            });
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.isUndefined(yield* store.readHubMember(space, env));
      assert.strictEqual(
        (yield* store.transact(store.readHubAdminTx(first.requestId)))?.stage,
        "prepared",
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.writeHubAdminTx({
              record: { ...first, requestDigest: "d".repeat(64) },
              expectedStage: "prepared",
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "configure publishes the initial empty checkpoint and internal membership atomically",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const first: Store.AdminRecord = {
          requestId: M.MemoryOperationId.make(id(220)),
          requestDigest: hash,
          expectedVersion: 0,
          stage: "prepared",
          action: {
            action: "configure",
            requestId: M.MemoryOperationId.make(id(220)),
            expectedVersion: 0,
            settings: { mode: "hub", memorySpaceId: space },
          },
          secretName: null,
          result: null,
          memberVersion: null,
        };
        yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
        const activation = {
          requestId: first.requestId,
          requestDigest: hash,
          memorySpaceId: space,
          environmentId: env,
          expectedCredentialVersion: null,
          next: { credentialDigest: hash },
          now: 0,
        };
        yield* store
          .transact(
            Effect.gen(function* () {
              yield* store.activateHubMemberTx(activation);
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            }),
          )
          .pipe(Effect.flip);
        assert.isUndefined(yield* store.readHubMember(space, env));
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_compaction_state WHERE published=1`).length,
          0,
        );
        const member = yield* store.transact(store.activateHubMemberTx(activation));
        assert.strictEqual(member.status, "active");
        const published = yield* sql<{
          published: number;
          checkpoint_id: string;
        }>`SELECT published,checkpoint_id FROM memory_compaction_state WHERE space=${space}`;
        assert.strictEqual(published[0]!.published, 1);
        const bytes = yield* store.transact(store.readHubUsageTx(space));
        assert.isAbove(bytes.checkpointBytes, 0);
        assert.strictEqual(bytes.liveHandles, 0);
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.deepStrictEqual(
          yield* fresh.transact(fresh.activateHubMemberTx(activation)),
          member,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE reason='hub_snapshot'`).length,
          1,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "bootstrap cannot become ready before the matching canonical checkpoint is published",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const progress = {
          memorySpaceId: space,
          hubEnvironmentId: env,
          checkpointId: "synthetic-checkpoint",
          snapshotToken: "synthetic-token",
          checkpointSequence: 5,
          nextCursor: null,
        };
        yield* store.transact(
          store.advanceBootstrapTx({ ...progress, expectedState: "unbound", nextState: "staging" }),
        );
        const error = yield* store
          .transact(
            store.advanceBootstrapTx({ ...progress, expectedState: "staging", nextState: "ready" }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "MemoryStoreConflict");
        if (error._tag === "MemoryStoreConflict")
          assert.strictEqual(error.code, "bootstrap_required");
      }).pipe(checkUsage, Effect.provide(live)),
  );
});

describe("MemoryStore transient source relay", () => {
  const owner = M.EnvironmentId.make("source-owner");
  const thread = { environmentId: owner, threadId: M.ThreadId.make("synthetic-thread") };
  const watermark = {
    fromEventId: M.EventId.make("synthetic-from"),
    toEventId: M.EventId.make("synthetic-to"),
    throughSequence: 8,
  };
  const messageId = M.MessageId.make("synthetic-message");
  const authority = (environmentId = env): Store.HubAuthority => ({
    principal: {
      memorySpaceId: space,
      environmentId,
      credentialVersion: 1,
      scopes: ["memory:sync"],
    },
    now: Clock.currentTimeMillis,
    reauthorize: Effect.void,
  });
  const request: M.MemoryHubSourceReadRequestInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    requestId: M.MemorySourceReadRequestId.make(id(300)),
    sourceThread: thread,
    sourceWatermark: watermark,
    messageIds: [messageId],
    limit: 10,
    authorizedScopes: ["memory:read", "orchestration:read"],
  };
  const seed = Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${env},${"a".repeat(64)},1,'active',0),(${space},${owner},${"b".repeat(64)},1,'active',0)`;
    const base = operation(301);
    if (base.kind !== "upsert")
      return yield* new Store.MemoryStoreConflict({ code: "invalid_output" });
    const op: M.MemoryOperation = {
      ...base,
      revision: {
        ...base.revision,
        provenance: { environmentId: env, sourceThread: thread, sourceWatermark: watermark },
      },
      payload: {
        text: "synthetic linked summary",
        evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: [messageId] }],
        derivedFromMemoryRevisions: [],
      },
    };
    const current = yield* store.loadAggregate(space, memory);
    yield* store.apply(decideMemoryOperation(current, op, Store.localIntent, scanMemoryValue(op)));
  });
  it.effect(
    "keeps the first deadline, routes only to the owner, and erases the consumed outcome",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* store.transact(store.requestHubSourceReadTx(authority(), request));
        yield* TestClock.adjust(1000);
        assert.deepStrictEqual(
          yield* store.transact(store.requestHubSourceReadTx(authority(), request)),
          first,
        );
        assert.deepStrictEqual(
          (yield* store.transact(
            store.collectHubSourceReadsTx(authority(), {
              protocolVersion: 1,
              memorySpaceId: space,
              limit: 32,
            }),
          )).requests,
          [],
        );
        assert.strictEqual(
          (yield* store.transact(
            store.collectHubSourceReadsTx(authority(owner), {
              protocolVersion: 1,
              memorySpaceId: space,
              limit: 32,
            }),
          )).requests.length,
          1,
        );
        const outcome: M.MemorySourceReadOutcome = {
          kind: "available",
          page: {
            sourceThread: thread,
            watermark,
            messages: [{ messageId, text: "synthetic original" }],
            nextCursor: null,
          },
        };
        const response = {
          kind: "normal" as const,
          ownerPolicyEpoch: 1,
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: request.requestId,
          outcome,
        };
        assert.strictEqual(
          (yield* store
            .transact(store.respondHubSourceReadTx(authority(), response))
            .pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual(
          (yield* store.transact(store.respondHubSourceReadTx(authority(owner), response)))
            .accepted,
          true,
        );
        assert.strictEqual(
          (yield* store.transact(store.respondHubSourceReadTx(authority(owner), response)))
            .accepted,
          true,
        );
        // Keep the real relay response unconsumed while an approved canonical change is scanned.
        const nextBase = operation(305);
        if (nextBase.kind !== "upsert") throw new Error("fixture");
        const current = yield* store.loadAggregate(space, memory);
        const next = {
          ...nextBase,
          expectedHeads: current.heads,
          revision: {
            ...nextBase.revision,
            parents: current.heads,
            provenance: { environmentId: env, sourceThread: thread, sourceWatermark: watermark },
          },
          payload: {
            ...nextBase.payload,
            evidence: [
              {
                origin: "thread" as const,
                sourceThread: thread,
                watermark,
                messageIds: [messageId],
              },
            ],
          },
        };
        const approved = decideMemoryOperation(
          current,
          next,
          Store.approvedReplica,
          scanMemoryValue(next),
          {
            operationId: next.operationId,
            memoryId: memory,
            operationDigest: memoryOperationDigest(next),
            outcome: "accepted",
            hubSequence: 2,
          },
        );
        yield* store.apply(approved);
        const scanner = (yield* store.readDeferred(yield* Clock.currentTimeMillis, 100)).find(
          (d) => d.kind === "scanner",
        )!;
        assert.isDefined(scanner);
        const chunk = yield* store.readScannerChunk(scanner);
        assert.isTrue(chunk.payloads.every((p) => "text" in p || "judgment" in p));
        assert.isFalse(JSON.stringify(chunk.payloads).includes("synthetic original"));
        assert.isTrue(
          yield* store.claimDeferred(scanner, "scanner", yield* Clock.currentTimeMillis, 2000),
        );
        assert.isTrue(
          yield* store.finishOwnedDeferred(scanner, "scanner", 2000, {
            now: yield* Clock.currentTimeMillis,
            scannerPolicyVersion: 1,
          }),
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${`relay:${request.requestId}`}`)
            .length,
          1,
        );
        assert.deepStrictEqual(
          yield* store.transact(
            store.resultHubSourceReadTx(authority(), {
              protocolVersion: 1,
              memorySpaceId: space,
              requestId: request.requestId,
            }),
          ),
          { state: "completed", outcome },
        );
        const rows = yield* sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_payloads WHERE payload_ref=${`relay:${request.requestId}`}`;
        assert.strictEqual(rows[0]!.count, 0);
        assert.strictEqual(
          (yield* store.transact(
            store.resultHubSourceReadTx(authority(), {
              protocolVersion: 1,
              memorySpaceId: space,
              requestId: request.requestId,
            }),
          )).state,
          "expired",
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("preserves post-lock 401 and 403 errors for relay and checkpoint ports", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      for (const failure of [
        new M.MemoryHubUnauthorizedError({}),
        new M.MemoryHubForbiddenError({}),
      ]) {
        const denied = { ...authority(), reauthorize: Effect.fail(failure) };
        assert.strictEqual(
          (yield* store.transact(store.requestHubSourceReadTx(denied, request)).pipe(Effect.flip))
            ._tag,
          failure._tag,
        );
        assert.strictEqual(
          (yield* store
            .transact(
              store.prepareHubCheckpointTx({
                authority: denied,
                checkpointId: "denied",
                snapshotToken: "denied",
                hubEnvironmentId: env,
              }),
            )
            .pipe(Effect.flip))._tag,
          failure._tag,
        );
        assert.strictEqual(
          (yield* store
            .transact(
              store.readHubCheckpointPageTx({
                authority: denied,
                snapshotToken: "missing",
                cursor: null,
              }),
            )
            .pipe(Effect.flip))._tag,
          failure._tag,
        );
      }
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_hub_members SET status='revoked' WHERE environment=${env}`;
      assert.strictEqual(
        (yield* store
          .transact(store.requestHubSourceReadTx(authority(), request))
          .pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_source_reads`).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("expires at exactly 75 seconds and a bounded sweep removes the locator", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* store.transact(store.requestHubSourceReadTx(authority(), request));
      yield* TestClock.adjust(75000);
      assert.deepStrictEqual(
        yield* store.transact(
          store.resultHubSourceReadTx(authority(), {
            protocolVersion: 1,
            memorySpaceId: space,
            requestId: request.requestId,
          }),
        ),
        { state: "expired", code: "source_unavailable" },
      );
      const cleanup = yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: Date.parse(first.request.expiresAtHubTime),
          limit: 1,
        }),
      );
      assert.strictEqual(cleanup.removedRows, 1);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_source_reads`).length, 0);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect.each(["pending", "completed"] as const)(
    `revoke terminal-denies %s, survives a new Store, and old revoke cannot touch reenrollment`,
    (state) =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.transact(store.requestHubSourceReadTx(authority(), request));
        const outcome: M.MemorySourceReadOutcome = {
          kind: "available",
          page: {
            sourceThread: thread,
            watermark,
            messages: [{ messageId, text: "synthetic original" }],
            nextCursor: null,
          },
        };
        const response: M.MemoryHubSourceReadRespondInput = {
          kind: "normal",
          protocolVersion: 1,
          memorySpaceId: space,
          requestId: request.requestId,
          ownerPolicyEpoch: 1,
          outcome,
        };
        if (state === "completed")
          yield* store.transact(store.respondHubSourceReadTx(authority(owner), response));
        const revoke: M.MemoryHubSourceReadRespondInput = {
          kind: "revoke",
          protocolVersion: 1,
          memorySpaceId: space,
          requesterEnvironmentId: env,
          ownerPolicyEpoch: 2,
        };
        const ack = yield* store.transact(store.respondHubSourceReadTx(authority(owner), revoke));
        assert.deepStrictEqual(ack, {
          kind: "revoke",
          accepted: true,
          ack: {
            memorySpaceId: space,
            ownerEnvironmentId: owner,
            requesterEnvironmentId: env,
            removalEpoch: 2,
            revokedThroughEpoch: 2,
          },
        });
        assert.deepStrictEqual(
          yield* store.transact(store.respondHubSourceReadTx(authority(owner), revoke)),
          ack,
        );
        const resultInput = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: request.requestId,
        };
        assert.deepStrictEqual(
          yield* store.transact(store.resultHubSourceReadTx(authority(), resultInput)),
          {
            state: "completed",
            outcome: { kind: "denied", requiredPermission: "orchestration:read" },
          },
        );
        assert.isFalse(
          (yield* store.transact(
            store.respondHubSourceReadTx(authority(owner), { ...response, ownerPolicyEpoch: 3 }),
          )).accepted,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'relay:%'`).length,
          0,
        );
        const fresh = yield* Layer.build(Store.layer);
        const restarted = Context.get(fresh, Store.MemoryStore);
        assert.deepStrictEqual(
          yield* restarted.transact(restarted.resultHubSourceReadTx(authority(), resultInput)),
          {
            state: "completed",
            outcome: { kind: "denied", requiredPermission: "orchestration:read" },
          },
        );
        const nextRequest = { ...request, requestId: M.MemorySourceReadRequestId.make(id(320)) };
        yield* restarted.transact(restarted.requestHubSourceReadTx(authority(), nextRequest));
        assert.isTrue(
          (yield* restarted.transact(
            restarted.respondHubSourceReadTx(authority(owner), {
              ...response,
              requestId: nextRequest.requestId,
              ownerPolicyEpoch: 3,
            }),
          )).accepted,
        );
        yield* restarted.transact(restarted.respondHubSourceReadTx(authority(owner), revoke));
        assert.deepStrictEqual(
          yield* restarted.transact(
            restarted.resultHubSourceReadTx(authority(), {
              ...resultInput,
              requestId: nextRequest.requestId,
            }),
          ),
          { state: "completed", outcome },
        );
        const fences = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM memory_import_keys WHERE key_kind='hub_source_fences'`;
        assert.strictEqual(fences.length, 1);
      }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect("refuses absent requester revoke without a durable membership high-water", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const result = yield* store
        .transact(
          store.respondHubSourceReadTx(authority(owner), {
            protocolVersion: 1,
            kind: "revoke",
            memorySpaceId: space,
            requesterEnvironmentId: M.EnvironmentId.make("absent"),
            ownerPolicyEpoch: 2,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(result._tag, "MemoryHubError");
      if (result._tag === "MemoryHubError") assert.strictEqual(result.code, "identity_mismatch");
    }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect.each(["legacy", "digest", "deadline", "credential"] as const)(
    `terminally denies corrupted persisted relay %s`,
    (mutation) =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* store.transact(store.requestHubSourceReadTx(authority(), request));
        if (mutation === "legacy")
          yield* sql`UPDATE memory_hub_source_reads SET locator_json=json_remove(locator_json,'$.stamp')`;
        if (mutation === "digest")
          yield* sql`UPDATE memory_hub_source_reads SET locator_json=json_set(locator_json,'$.stamp.locatorDigest',${"c".repeat(64)})`;
        if (mutation === "deadline")
          yield* sql`UPDATE memory_hub_source_reads SET locator_json=json_set(locator_json,'$.expiresAtHubTime','1970-01-01T00:02:00.000Z')`;
        if (mutation === "credential")
          yield* sql`UPDATE memory_hub_source_reads SET locator_json=json_set(locator_json,'$.stamp.requesterCredentialVersion',2)`;
        const result = yield* store.transact(
          store.resultHubSourceReadTx(authority(), {
            protocolVersion: 1,
            memorySpaceId: space,
            requestId: request.requestId,
          }),
        );
        assert.deepStrictEqual(result, {
          state: "completed",
          outcome: { kind: "denied", requiredPermission: "orchestration:read" },
        });
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("bounds source admission to 32 per requester and 128 per hub", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const extra = ["requester-c", "requester-d", "requester-e"].map((value) =>
        M.EnvironmentId.make(value),
      );
      for (const [n, e] of extra.entries())
        yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${e},${String(n + 3).repeat(64)},1,'active',0)`;
      let ordinal = 9300;
      for (const e of [env, owner, ...extra.slice(0, 2)]) {
        for (let n = 0; n < 32; n++)
          yield* store.transact(
            store.requestHubSourceReadTx(authority(e), {
              ...request,
              requestId: M.MemorySourceReadRequestId.make(id(ordinal++)),
            }),
          );
        if (e === env) {
          const error = yield* store
            .transact(
              store.requestHubSourceReadTx(authority(e), {
                ...request,
                requestId: M.MemorySourceReadRequestId.make(id(ordinal++)),
              }),
            )
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "MemoryCapacityError");
          if (error._tag === "MemoryCapacityError")
            assert.strictEqual(error.dimension, "relay_environment");
        }
      }
      const error = yield* store
        .transact(
          store.requestHubSourceReadTx(authority(extra[2]!), {
            ...request,
            requestId: M.MemorySourceReadRequestId.make(id(ordinal++)),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "MemoryCapacityError");
      if (error._tag === "MemoryCapacityError") assert.strictEqual(error.dimension, "relay_hub");
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_source_reads`).length, 128);
      const collected = yield* store.transact(
        store.collectHubSourceReadsTx(authority(owner), {
          protocolVersion: 1,
          memorySpaceId: space,
          limit: 32,
        }),
      );
      assert.strictEqual(collected.requests.length, 32);
      const encoded = yield* encodeSourceCollect(collected);
      assert.isAtMost(new TextEncoder().encode(encoded).length, 65536);
    }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect("rejects an oversized source outcome without retaining its body", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.transact(store.requestHubSourceReadTx(authority(), request));
      const response: M.MemoryHubSourceReadRespondInput = {
        protocolVersion: 1,
        kind: "normal",
        ownerPolicyEpoch: 1,
        memorySpaceId: space,
        requestId: request.requestId,
        outcome: {
          kind: "available",
          page: {
            sourceThread: thread,
            watermark,
            messages: [{ messageId, text: "x".repeat(65536) }],
            nextCursor: null,
          },
        },
      };
      const result = yield* Effect.result(
        store.transact(store.respondHubSourceReadTx(authority(owner), response)),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'relay:%'`).length,
        0,
      );
      assert.strictEqual(
        (yield* store.transact(
          store.resultHubSourceReadTx(authority(), {
            protocolVersion: 1,
            memorySpaceId: space,
            requestId: request.requestId,
          }),
        )).state,
        "pending",
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "reopens SQLite with the original relay deadline, unconsumed body and durable pair fence",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "source-relay-restart-" });
        const filename = `${dir}/relay.sqlite`;
        const db = NodeSqliteClient.layer({ filename });
        const firstLayer = Store.layer.pipe(
          Layer.provideMerge(
            Layer.effectDiscard(
              migration.pipe(
                Effect.andThen(hubMigration),
                Effect.andThen(lineageMigration),
                Effect.andThen(checkpointMigration),
                Effect.andThen(revisionSizeMigration),
                Effect.andThen(reportMigration),
                Effect.andThen(usageMigration),
                Effect.andThen(revertMigration),
                Effect.andThen(readyMigration),
                Effect.andThen(adminMigration),
                Effect.andThen(lifecycleMigration),
                Effect.andThen(searchMigration),
              ),
            ).pipe(Layer.provideMerge(db)),
          ),
        );
        const resultInput = {
          protocolVersion: 1 as const,
          memorySpaceId: space,
          requestId: request.requestId,
        };
        const outcome: M.MemorySourceReadOutcome = {
          kind: "available",
          page: {
            sourceThread: thread,
            watermark,
            messages: [{ messageId, text: "synthetic restart original" }],
            nextCursor: null,
          },
        };
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* seed;
            const store = yield* Store.MemoryStore;
            const requested = yield* store.transact(
              store.requestHubSourceReadTx(authority(), request),
            );
            yield* store.transact(
              store.respondHubSourceReadTx(authority(owner), {
                protocolVersion: 1,
                kind: "normal",
                ownerPolicyEpoch: 1,
                memorySpaceId: space,
                requestId: request.requestId,
                outcome,
              }),
            );
            return requested;
          }).pipe(Effect.provide(firstLayer)),
        );
        yield* TestClock.adjust(1000);
        const reopenedLayer = () =>
          Store.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* Store.MemoryStore;
            assert.deepStrictEqual(
              yield* store.transact(store.requestHubSourceReadTx(authority(), request)),
              first,
            );
            assert.deepStrictEqual(
              yield* store.transact(store.resultHubSourceReadTx(authority(), resultInput)),
              { state: "completed", outcome },
            );
            const next = { ...request, requestId: M.MemorySourceReadRequestId.make(id(9550)) };
            yield* store.transact(store.requestHubSourceReadTx(authority(), next));
            yield* store.transact(
              store.respondHubSourceReadTx(authority(owner), {
                protocolVersion: 1,
                kind: "revoke",
                memorySpaceId: space,
                requesterEnvironmentId: env,
                ownerPolicyEpoch: 2,
              }),
            );
          }).pipe(Effect.provide(reopenedLayer())),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* Store.MemoryStore;
            assert.deepStrictEqual(
              yield* store.transact(
                store.resultHubSourceReadTx(authority(), {
                  ...resultInput,
                  requestId: M.MemorySourceReadRequestId.make(id(9550)),
                }),
              ),
              {
                state: "completed",
                outcome: { kind: "denied", requiredPermission: "orchestration:read" },
              },
            );
            const ack = yield* store.transact(
              store.respondHubSourceReadTx(authority(owner), {
                protocolVersion: 1,
                kind: "revoke",
                memorySpaceId: space,
                requesterEnvironmentId: env,
                ownerPolicyEpoch: 2,
              }),
            );
            assert.strictEqual(ack.kind, "revoke");
            if (ack.kind === "revoke") assert.strictEqual(ack.ack.revokedThroughEpoch, 2);
          }).pipe(Effect.provide(reopenedLayer())),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("MemoryStore durable hub checkpoints", () => {
  const authority: Store.HubAuthority = {
    principal: {
      memorySpaceId: space,
      environmentId: env,
      credentialVersion: 1,
      scopes: ["memory:sync"],
    },
    now: Clock.currentTimeMillis,
    reauthorize: Effect.void,
  };
  const seed = Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${env},${"a".repeat(64)},1,'active',0)`;
    const op = operation(401);
    yield* store.transact(
      Effect.gen(function* () {
        const current = yield* store.loadAggregate(space, memory);
        const decision = decideMemoryOperation(
          current,
          op,
          Store.hubAdmission,
          scanMemoryValue(op),
        );
        const ledger = yield* store.appendHubEntryTx({
          operation: op,
          operationDigest: memoryOperationDigest(op),
          outcome: "accepted",
          now: 0,
        });
        yield* store.apply({ ...decision, receipt: ledger.entry.receipt });
      }),
    );
  });
  it.effect(
    "producer staging preserves the hub member token, immutable pages and TTL floor pin",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const handle = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "member-initial",
            snapshotToken: "member-token",
            hubEnvironmentId: env,
          }),
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 0,
          }),
        );
        const initial = yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: handle.snapshotToken,
            cursor: null,
          }),
        );
        const guardBefore =
          yield* sql`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`;
        const memberBefore = yield* sql`SELECT * FROM memory_hub_members WHERE space=${space}`;
        const base = operation(402);
        if (base.kind === "forget") throw new Error("fixture");
        const op = decodeOperation({
          ...base,
          expectedHeads: [M.MemoryRevisionId.make(id(411))],
          revision: { ...base.revision, parents: [M.MemoryRevisionId.make(id(411))] },
        });
        yield* store.transact(
          Effect.gen(function* () {
            const next = yield* store.appendHubEntryTx({
              operation: op,
              operationDigest: memoryOperationDigest(op),
              outcome: "accepted",
              now: 0,
            });
            yield* store.apply({
              ...decideMemoryOperation(
                yield* store.loadAggregate(space, memory),
                op,
                Store.hubAdmission,
                { kind: "allowed" },
              ),
              receipt: next.entry.receipt,
            });
          }),
        );
        for (const name of ["producer-next", "producer-repeat"]) {
          yield* store.transact(
            Effect.gen(function* () {
              const staged = yield* store.prepareHubProducerCheckpointTx({
                authority,
                checkpointId: name,
                hubEnvironmentId: env,
              });
              assert.strictEqual(staged.checkpointSequence, 2);
              assert.isAbove(
                (yield* store.readHubUsageTx(space)).checkpointReservationConsumedBytes,
                0,
              );
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: staged.checkpointId,
                expectedFloor: 1,
                nextFloor: 1,
                now: 0,
              });
              assert.strictEqual(
                (yield* store.readHubUsageTx(space)).checkpointReservationConsumedBytes,
                0,
              );
            }),
          );
          assert.deepStrictEqual(
            yield* store.transact(
              store.readHubCheckpointPageTx({
                authority,
                snapshotToken: handle.snapshotToken,
                cursor: null,
              }),
            ),
            initial,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`,
            guardBefore,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM memory_hub_members WHERE space=${space}`,
            memberBefore,
          );
        }
        const guard = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token'`;
        const parsed = JSON.parse(guard[0]!.record_json);
        assert.strictEqual(parsed.retired, false);
        assert.strictEqual(parsed.handle.firstIssuedAt, 0);
        assert.strictEqual(parsed.handle.expiresAt, M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
        assert.strictEqual(parsed.handle.credentialVersion, 1);
        assert.strictEqual(
          (yield* store
            .transact(
              store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: "producer-repeat",
                expectedFloor: 1,
                nextFloor: 2,
                now: 0,
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
        const expired = yield* store
          .transact(
            store.readHubCheckpointPageTx({
              authority,
              snapshotToken: handle.snapshotToken,
              cursor: null,
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(expired._tag, "MemoryHubError");
        if (expired._tag === "MemoryHubError") assert.strictEqual(expired.code, "cursor_expired");
        const advanced = yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: "producer-repeat",
            expectedFloor: 1,
            nextFloor: 2,
            now: M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          }),
        );
        assert.strictEqual(advanced.retentionFloor, 2);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "producer reauthenticates the real hub and rolls back capacity and outer publication failure",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const handle = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "producer-safe",
            snapshotToken: "producer-safe-token",
            hubEnvironmentId: env,
          }),
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 0,
          }),
        );
        const preparation = { authority, checkpointId: "producer-failed", hubEnvironmentId: env };
        assert.strictEqual(
          (yield* store
            .transact(
              store.prepareHubProducerCheckpointTx({
                ...preparation,
                hubEnvironmentId: M.EnvironmentId.make("foreign-hub"),
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubForbiddenError",
        );
        assert.strictEqual(
          (yield* store
            .transact(
              store.prepareHubProducerCheckpointTx({
                ...preparation,
                authority: {
                  ...authority,
                  reauthorize: Effect.fail(new M.MemoryHubUnauthorizedError({})),
                },
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubUnauthorizedError",
        );
        const before = yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`;
        yield* store
          .transact(
            Effect.gen(function* () {
              const staged = yield* store.prepareHubProducerCheckpointTx(preparation);
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: staged.checkpointId,
                expectedFloor: 1,
                nextFloor: 1,
                now: 0,
              });
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            }),
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`,
          before,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:producer-failed'`)
            .length,
          0,
        );
        const usage = yield* store.transact(store.readHubUsageTx(space));
        yield* sql`UPDATE memory_hub_retention SET published_pinned_bytes=${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - usage.requiredCheckpointBoundBytes} WHERE space=${space}`;
        const full = yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`;
        const guards =
          yield* sql`SELECT * FROM memory_import_keys WHERE key_kind='hub_checkpoint_token'`;
        const capacity = yield* store
          .transact(
            Effect.gen(function* () {
              const staged = yield* store.prepareHubProducerCheckpointTx(preparation);
              assert.strictEqual(
                (yield* store.readHubUsageTx(space)).stagingBytes,
                M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
              );
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: staged.checkpointId,
                expectedFloor: 1,
                nextFloor: 1,
                now: 0,
              });
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(capacity._tag, "MemoryCapacityError");
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`,
          full,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_import_keys WHERE key_kind='hub_checkpoint_token'`,
          guards,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:producer-failed'`)
            .length,
          0,
        );
        assert.strictEqual(
          (yield* store.transact(
            store.readHubCheckpointPageTx({
              authority,
              snapshotToken: handle.snapshotToken,
              cursor: null,
            }),
          )).checkpointSequence,
          1,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "pins complete pages with immutable expiry and publishes recovery independently of token lifetime",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const preparation = {
          authority,
          checkpointId: "synthetic-cp-401",
          snapshotToken: "synthetic-token-401",
          hubEnvironmentId: env,
        };
        const handle = yield* store.transact(store.prepareHubCheckpointTx(preparation));
        yield* TestClock.adjust(1000);
        assert.deepStrictEqual(
          yield* store.transact(store.prepareHubCheckpointTx(preparation)),
          handle,
        );
        const page = yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: handle.snapshotToken,
            cursor: null,
          }),
        );
        assert.strictEqual(page.bootstrapComplete, true);
        assert.strictEqual(page.revisions[0]?.payload?.text, "synthetic searchable text");
        assert.strictEqual(M.validateMemoryCheckpointRecords([page]), true);
        const retention = yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 1000,
          }),
        );
        assert.strictEqual(retention.retentionFloor, 1);
        yield* TestClock.adjust(599000);
        assert.strictEqual(
          (yield* store
            .transact(
              store.readHubCheckpointPageTx({
                authority,
                snapshotToken: handle.snapshotToken,
                cursor: null,
              }),
            )
            .pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE reason='hub_snapshot'`).length,
          1,
        );
        yield* store.transact(
          store.purgeHubTransientTx({ memorySpaceId: space, now: 600000, limit: 100 }),
        );
        assert.strictEqual(
          (yield* store.transact(store.prepareHubCheckpointTx(preparation)).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
        assert.strictEqual(
          (yield* fresh.transact(fresh.prepareHubCheckpointTx(preparation)).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_compaction_state WHERE published=1`).length,
          1,
        );
        assert.strictEqual(
          (yield* store.transact(store.readHubUsageTx(space))).publishedPinnedBytes > 0,
          true,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("never revives a replaced token even while its published pages survive", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const first = {
        authority,
        checkpointId: "token-replacement",
        snapshotToken: "old-token",
        hubEnvironmentId: env,
      };
      yield* store.transact(store.prepareHubCheckpointTx(first));
      yield* store.transact(
        store.publishCheckpointAndFloorTx({
          memorySpaceId: space,
          checkpointId: first.checkpointId,
          expectedFloor: 0,
          nextFloor: 1,
          now: 0,
        }),
      );
      yield* TestClock.adjust(1000);
      const replacement = yield* store.transact(
        store.prepareHubCheckpointTx({ ...first, snapshotToken: "new-token" }),
      );
      assert.strictEqual(replacement.firstIssuedAt, 1000);
      assert.strictEqual(
        (yield* store.transact(store.prepareHubCheckpointTx(first)).pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.readHubCheckpointPageTx({
              authority,
              snapshotToken: first.snapshotToken,
              cursor: null,
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubError",
      );
      assert.strictEqual(
        (yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: replacement.snapshotToken,
            cursor: null,
          }),
        )).checkpointSequence,
        1,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("forget scrubs a pinned snapshot immediately without changing its continuation", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      const preparation = {
        authority,
        checkpointId: "synthetic-cp-402",
        snapshotToken: "synthetic-token-402",
        hubEnvironmentId: env,
      };
      const handle = yield* store.transact(store.prepareHubCheckpointTx(preparation));
      const before = yield* store.transact(
        store.readHubCheckpointPageTx({
          authority,
          snapshotToken: handle.snapshotToken,
          cursor: null,
        }),
      );
      const op = decodeOperation({
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId: memory,
        operationId: id(402),
        originEnvironmentId: env,
        expectedHeads: [id(411)],
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: id(402),
          deletingEnvironmentId: env,
          deletedAtUtc: now,
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* store.transact(
        Effect.gen(function* () {
          const decision = decideMemoryOperation(
            yield* store.loadAggregate(space, memory),
            op,
            Store.hubAdmission,
            scanMemoryValue(op),
          );
          const ledger = yield* store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome: "deleted",
            now: 1,
          });
          yield* store.apply({ ...decision, receipt: ledger.entry.receipt });
        }),
      );
      const after = yield* store.transact(
        store.readHubCheckpointPageTx({
          authority,
          snapshotToken: handle.snapshotToken,
          cursor: null,
        }),
      );
      assert.strictEqual(after.pageOrdinal, before.pageOrdinal);
      assert.strictEqual(after.nextCursor, before.nextCursor);
      assert.strictEqual(after.checkpointSequence, before.checkpointSequence);
      assert.strictEqual(after.revisions[0]?.payload, null);
      assert.strictEqual(after.items[0]?.status, "blocked");
      assert.strictEqual(M.validateMemoryCheckpointRecords([after]), true);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "floor publication rolls back and covered tail compaction preserves replay metadata",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        const handle = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority,
            checkpointId: "synthetic-cp-403",
            snapshotToken: "synthetic-token-403",
            hubEnvironmentId: env,
          }),
        );
        yield* store
          .transact(
            Effect.gen(function* () {
              yield* store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: handle.checkpointId,
                expectedFloor: 0,
                nextFloor: 1,
                now: 0,
              });
              return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
            }),
          )
          .pipe(Effect.flip);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).retentionFloor,
          0,
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: handle.checkpointId,
            expectedFloor: 0,
            nextFloor: 1,
            now: 0,
          }),
        );
        const status = yield* store.transact(
          store.compactEligibleHistoryTx({
            memorySpaceId: space,
            expectedFloor: 1,
            now: 2592000000,
            limit: 1,
          }),
        );
        assert.strictEqual(status.removedRows, 1);
        assert.strictEqual(
          (yield* store.transact(store.readHubReceiptTx(space, operation(401).operationId)))?.entry
            .receipt.outcome,
          "accepted",
        );
        assert.strictEqual((yield* store.transact(store.readHubUsageTx(space))).tailRows, 0);
      }).pipe(checkUsage, Effect.provide(live)),
  );
});

const seedResolutionConflict = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${hash},1,'active')`;
  const first = operation();
  if (first.kind !== "upsert") throw new Error("fixture");
  for (const op of [
    first,
    ...[4, 5].map((n) => {
      const next = operation(n);
      if (next.kind !== "upsert") throw new Error("fixture");
      return {
        ...next,
        expectedHeads: [first.revision.revisionId],
        revision: { ...next.revision, parents: [first.revision.revisionId] },
      };
    }),
  ]) {
    yield* store.apply(
      decideMemoryOperation(yield* store.loadAggregate(space, memory), op, Store.hubAdmission, {
        kind: "allowed",
      }),
    );
  }
  const aggregate = yield* store.loadAggregate(space, memory);
  return {
    store,
    sql,
    claim: {
      protocolVersion: 1 as const,
      memorySpaceId: space,
      memoryId: memory,
      holderEnvironmentId: env,
      conflictId: aggregate.conflicts[0]!.conflictId,
      conflictHeadSet: aggregate.heads,
      attemptId: M.MemoryOperationId.make(id(70)),
      frozenDefaultModelSelection: {
        instanceId: M.ProviderInstanceId.make("fixture"),
        model: "fixture",
      },
    },
  };
});
const leaseAuthority: Store.HubAuthority = {
  principal: {
    memorySpaceId: space,
    environmentId: env,
    credentialVersion: 1,
    scopes: ["memory:sync"],
  },
  now: Clock.currentTimeMillis,
  reauthorize: Effect.void,
};
it.effect("never reissues released invalidated or replaced attempts across restart", () =>
  Effect.gen(function* () {
    const { store, sql, claim } = yield* seedResolutionConflict;
    const first = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: claim },
      }),
    );
    if (!first || "released" in first) throw new Error("fixture");
    const release = { ...claim, fencingToken: first.fencingToken };
    yield* TestClock.adjust(10);
    yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "release", request: release },
      }),
    );
    const retry = () =>
      store
        .transact(
          store.transitionHubLeaseTx({
            authority: leaseAuthority,
            action: { kind: "claim", request: claim },
          }),
        )
        .pipe(Effect.flip);
    assert.strictEqual((yield* retry())._tag, "MemoryHubError");
    const secondClaim = { ...claim, attemptId: M.MemoryOperationId.make(id(71)) };
    const second = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: secondClaim },
      }),
    );
    if (!second || "released" in second) throw new Error("fixture");
    yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: {
          kind: "invalidate",
          memoryId: memory,
          expectedToken: second.fencingToken,
          reason: "heads",
        },
      }),
    );
    assert.strictEqual(
      (yield* store
        .transact(
          store.transitionHubLeaseTx({
            authority: leaseAuthority,
            action: { kind: "claim", request: secondClaim },
          }),
        )
        .pipe(Effect.flip))._tag,
      "MemoryHubError",
    );
    const thirdClaim = { ...claim, attemptId: M.MemoryOperationId.make(id(72)) };
    yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: thirdClaim },
      }),
    );
    assert.strictEqual(
      (yield* Effect.gen(function* () {
        const restarted = yield* Store.MemoryStore;
        return yield* restarted
          .transact(
            restarted.transitionHubLeaseTx({
              authority: leaseAuthority,
              action: { kind: "claim", request: claim },
            }),
          )
          .pipe(Effect.flip);
      }).pipe(Effect.provide(Store.layer)))._tag,
      "MemoryHubError",
    );
    yield* TestClock.adjust(M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS);
    assert.strictEqual((yield* retry())._tag, "MemoryHubError");
    const guards = yield* sql<{
      key: string;
      record_json: string;
    }>`SELECT key,record_json FROM memory_import_keys WHERE key_kind='hub_attempt' ORDER BY key`;
    assert.strictEqual(guards.length, 3);
    assert.strictEqual(JSON.parse(guards[0]!.record_json).deadline, 600000);
    assert.strictEqual(JSON.parse(guards[0]!.record_json).fencingToken, first.fencingToken);
  }).pipe(checkUsage, Effect.provide(live)),
);
it.effect("purges submission bodies in every ticket state and fences cancelled ownership", () =>
  Effect.gen(function* () {
    const { store, sql, claim } = yield* seedResolutionConflict;
    const ticket = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: claim },
      }),
    );
    if (!ticket || "released" in ticket) throw new Error("fixture");
    yield* store.persistResolutionTicket(ticket);
    const key = { memorySpaceId: space, attemptId: ticket.attemptId };
    const owner = yield* store.transact(
      store.acquireResolutionTicketTx({
        key,
        expectedVersion: 0,
        owner: "fixture",
        coordinatorEpoch: 1,
        now: 0,
        ownedUntil: 100,
      }),
    );
    const base = operation(80);
    if (base.kind !== "upsert" || !owner) throw new Error("fixture");
    const op = decodeOperation({
      ...base,
      kind: "resolve",
      expectedHeads: claim.conflictHeadSet,
      revision: { ...base.revision, parents: claim.conflictHeadSet },
      conflictId: claim.conflictId,
      fencingToken: ticket.fencingToken,
      payload: { ...base.payload, text: "synthetic submission body" },
      resolution: {
        resolutionId: id(81),
        memorySpaceId: space,
        memoryId: memory,
        inputRevisionIds: claim.conflictHeadSet,
        inputPayloadRefs: claim.conflictHeadSet,
        judgmentRef: id(81),
        requestedModelSelection: claim.frozenDefaultModelSelection,
        effectiveProvider: "codex",
        effectiveModel: "fixture",
        resolvingEnvironmentId: env,
        fencingToken: ticket.fencingToken,
        resultRevisionId: base.revision.revisionId,
        appliedAtUtc: now,
        revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
      },
      resolutionPayload: { resolutionId: id(81), judgment: "synthetic submission judgment" },
    });
    const submission = {
      protocolVersion: 1 as const,
      memorySpaceId: space,
      holderEnvironmentId: env,
      attemptId: ticket.attemptId,
      operation: op,
    };
    const ownership = { ...key, owner: "fixture", coordinatorEpoch: 1, version: owner.version };
    const written = yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(op),
      }),
    );
    const recovered = yield* store.readRecoverableResolutionTickets({
      memorySpaceId: space,
      now: 101,
      limit: 10,
    });
    assert.deepStrictEqual(recovered[0]?.submission, submission);
    const workId = `resolve:${space}:${ticket.attemptId}`;
    const before = yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE id=${workId}`;
    assert.notInclude(before[0]!.ticket_json, "synthetic submission body");
    assert.notInclude(before[0]!.ticket_json, "synthetic submission judgment");
    for (const status of ["completed", "failed"]) {
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,ticket_json,sync_version,next_attempt_at) SELECT ${`${workId}:${status}`},space,memory_id,kind,${status},metadata_json,ticket_json,sync_version,0 FROM memory_outbox WHERE id=${workId}`;
    }
    const forgotten: M.MemoryOperation = {
      protocolVersion: 1,
      kind: "forget",
      memorySpaceId: space,
      memoryId: memory,
      operationId: M.MemoryOperationId.make(id(82)),
      originEnvironmentId: env,
      expectedHeads: [],
      tombstone: {
        memorySpaceId: space,
        memoryId: memory,
        deleteOperationId: M.MemoryOperationId.make(id(82)),
        deletingEnvironmentId: env,
        deletedAtUtc: M.MemoryUtcTimestamp.make(now),
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      },
    };
    yield* store.apply(
      decideMemoryOperation(
        yield* store.loadAggregate(space, memory),
        forgotten,
        Store.hubAdmission,
        { kind: "allowed" },
      ),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${memory}`).length,
      0,
    );
    const rows = yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE kind='resolve'`;
    assert.strictEqual(rows.length, 3);
    for (const row of rows) {
      const value = JSON.parse(row.ticket_json);
      assert.isNull(value.submission);
      assert.isNull(value.owner);
      assert.strictEqual(value.state, "terminal");
      assert.isAbove(value.version, written.version);
    }
    assert.deepStrictEqual(
      yield* store.readRecoverableResolutionTickets({ memorySpaceId: space, now: 101, limit: 10 }),
      [],
    );
    assert.isNull(
      yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: written.version,
          owner: "retry",
          coordinatorEpoch: 2,
          now: 101,
          ownedUntil: 200,
        }),
      ),
    );
    assert.strictEqual(
      (yield* store
        .transact(
          store.persistResolutionSubmissionTx({
            ownership: { ...ownership, version: written.version },
            submission,
            digest: memoryOperationDigest(op),
          }),
        )
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${memory}`).length,
      0,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

const seedSubmission = Effect.gen(function* () {
  const { store, sql, claim } = yield* seedResolutionConflict;
  const ticket = yield* store.transact(
    store.transitionHubLeaseTx({
      authority: leaseAuthority,
      action: { kind: "claim", request: claim },
    }),
  );
  if (!ticket || "released" in ticket) throw new Error("fixture");
  yield* store.persistResolutionTicket(ticket);
  const key = { memorySpaceId: space, attemptId: ticket.attemptId };
  const owner = yield* store.transact(
    store.acquireResolutionTicketTx({
      key,
      expectedVersion: 0,
      owner: "fixture",
      coordinatorEpoch: 1,
      now: 0,
      ownedUntil: 100,
    }),
  );
  const base = operation(80);
  if (base.kind !== "upsert" || !owner) throw new Error("fixture");
  const op = decodeOperation({
    ...base,
    kind: "resolve",
    expectedHeads: claim.conflictHeadSet,
    revision: { ...base.revision, parents: claim.conflictHeadSet },
    conflictId: claim.conflictId,
    fencingToken: ticket.fencingToken,
    payload: { ...base.payload, text: "synthetic submission body" },
    resolution: {
      resolutionId: id(81),
      memorySpaceId: space,
      memoryId: memory,
      inputRevisionIds: claim.conflictHeadSet,
      inputPayloadRefs: claim.conflictHeadSet,
      judgmentRef: id(81),
      requestedModelSelection: claim.frozenDefaultModelSelection,
      effectiveProvider: "codex",
      effectiveModel: "fixture",
      resolvingEnvironmentId: env,
      fencingToken: ticket.fencingToken,
      resultRevisionId: base.revision.revisionId,
      appliedAtUtc: now,
      revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
    },
    resolutionPayload: { resolutionId: id(81), judgment: "synthetic submission judgment" },
  });
  const submission = {
    protocolVersion: 1 as const,
    memorySpaceId: space,
    holderEnvironmentId: env,
    attemptId: ticket.attemptId,
    operation: op,
  };
  const ownership = { ...key, owner: "fixture", coordinatorEpoch: 1, version: owner.version };
  return { store, sql, ticket, key, ownership, submission };
});

it.effect("rejects mismatched ticket identities before saving a submission and on recovery", () =>
  Effect.gen(function* () {
    const { store, sql, key, ownership, submission } = yield* seedSubmission;
    const base = submission.operation;
    if (base.kind !== "resolve") throw new Error("fixture");
    for (const op of [
      {
        ...base,
        memoryId: M.MemoryId.make(id(950)),
        revision: { ...base.revision, memoryId: M.MemoryId.make(id(950)) },
        resolution: { ...base.resolution, memoryId: M.MemoryId.make(id(950)) },
      },
      { ...base, conflictId: M.MemoryConflictId.make(id(951)) },
      {
        ...base,
        fencingToken: base.fencingToken + 1,
        resolution: { ...base.resolution, fencingToken: base.fencingToken + 1 },
      },
    ]) {
      const failure = yield* store
        .transact(
          store.persistResolutionSubmissionTx({
            ownership,
            submission: { ...submission, operation: op },
            digest: memoryOperationDigest(op),
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryStoreConflict");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        0,
      );
    }
    yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(base),
      }),
    );
    const workId = `resolve:${space}:${key.attemptId}`;
    yield* sql`UPDATE memory_outbox SET ticket_json=json_set(ticket_json,'$.ticket.memoryId',${id(950)}) WHERE id=${workId}`;
    const failure = yield* store
      .readRecoverableResolutionTickets({ memorySpaceId: space, now: 101, limit: 10 })
      .pipe(Effect.flip);
    assert.strictEqual(failure.stage, "ticket-payload-identity");
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["completed", "failed", "cancelled", "transition"] as const)(
  "clears terminal submission atomically while protecting uncertain recovery: %s",
  (status) =>
    Effect.gen(function* () {
      const { store, sql, key, ownership, submission } = yield* seedSubmission;
      const written = yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership,
          submission,
          digest: memoryOperationDigest(submission.operation),
        }),
      );
      const deadline = Date.parse(
        submission.operation.kind === "resolve"
          ? submission.operation.resolution.revertDeadlineUtc
          : now,
      );
      yield* store.prunePayloads(deadline + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS, 100);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        1,
      );
      assert.deepStrictEqual(
        (yield* store.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 101,
          limit: 10,
        }))[0]?.submission,
        submission,
      );
      const workId = `resolve:${space}:${key.attemptId}`;
      const finish = Effect.gen(function* () {
        return yield* status === "transition"
          ? store.transact(
              store.transitionResolutionTicketTx({
                ownership: { ...ownership, version: written.version },
                nextState: "terminal",
                now: 1,
                ownedUntil: null,
                nextAttemptAt: 1,
              }),
            )
          : store.finishWork(workId, status).pipe(Effect.as(null));
      });
      yield* store
        .transact(
          finish.pipe(
            Effect.andThen(
              Effect.fail(new Store.MemoryStoreConflict({ code: "revision_changed" })),
            ),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        1,
      );
      yield* finish;
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref LIKE 'submission:%'`).length,
        0,
      );
      assert.deepStrictEqual(
        yield* store.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 101,
          limit: 10,
        }),
        [],
      );
      const rows = yield* sql<{
        ticket_json: string;
      }>`SELECT ticket_json FROM memory_outbox WHERE id=${workId}`;
      const terminal = JSON.parse(rows[0]!.ticket_json);
      assert.isNull(terminal.submission);
      assert.isNull(terminal.owner);
      assert.isAbove(terminal.version, written.version);
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(
        yield* fresh.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 101,
          limit: 10,
        }),
        [],
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each([0, 1])(
  "enforces global metadata equality plus %s across spaces without leaking failed writes",
  (extra) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const record: Store.AdminRecord = {
        requestId: M.MemoryOperationId.make(id(971)),
        requestDigest: hash,
        expectedVersion: 0,
        stage: "prepared",
        action: {
          action: "configure",
          requestId: M.MemoryOperationId.make(id(971)),
          expectedVersion: 0,
          settings: { mode: "hub", memorySpaceId: space },
        },
        secretName: null,
        result: null,
        memberVersion: null,
      };
      // Measure the real write's encoded delta under rollback, then reserve the rest in another space.
      let delta = 0;
      yield* store
        .transact(
          Effect.gen(function* () {
            const before = yield* sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata'`;
            yield* store.writeHubAdminTx({ record, expectedStage: null });
            const after = yield* sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata'`;
            delta = after[0]!.value - before[0]!.value;
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.isAbove(delta, 0);
      const filler = M.MEMORY_PERMANENT_METADATA_MAX_BYTES - delta - 2 + extra;
      // Private retention detail isolates the metadata cap from required snapshot inputs.
      yield* sql`INSERT INTO memory_hub_retention(space,compaction_json) VALUES ('other',${"x".repeat(filler)})`;
      if (extra) {
        const failure = yield* store
          .transact(store.writeHubAdminTx({ record, expectedStage: null }))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryCapacityError");
        assert.isUndefined(yield* store.transact(store.readHubAdminTx(record.requestId)));
      } else {
        yield* store.transact(store.writeHubAdminTx({ record, expectedStage: null }));
        assert.isDefined(yield* store.transact(store.readHubAdminTx(record.requestId)));
      }
      const counters = yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata'`;
      assert.strictEqual(
        counters[0]!.value,
        M.MEMORY_PERMANENT_METADATA_MAX_BYTES + extra - (extra ? delta : 0),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["current", "replaced-compactor", "replaced-prune"] as const)(
  "protects revert inputs and collects expired canonical judgment with %s result",
  (mode) =>
    Effect.gen(function* () {
      const { store, sql, ticket, submission } = yield* seedSubmission;
      for (const n of [3, 4, 5]) {
        const op = yield* store.readOperation(space, M.MemoryOperationId.make(id(n)));
        if (!op) throw new Error("fixture");
        const ledger = yield* store.transact(
          store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome: n === 5 ? "conflicted" : "accepted",
            now: 0,
          }),
        );
        yield* store.apply({
          ...decideMemoryOperation(
            yield* store.loadAggregate(space, memory),
            op,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
          receipt: ledger.entry.receipt,
        });
      }
      const op = submission.operation;
      if (op.kind !== "resolve") throw new Error("fixture");
      const appliedAt = Date.parse(op.resolution.appliedAtUtc);
      const expiresAt = Date.parse(op.resolution.revertDeadlineUtc);
      const ledger = yield* store.transact(
        store.appendHubEntryTx({
          operation: op,
          operationDigest: memoryOperationDigest(op),
          outcome: "accepted",
          resolutionApproval: {
            resolutionId: op.resolution.resolutionId,
            appliedAtUtc: op.resolution.appliedAtUtc,
            revertDeadlineUtc: op.resolution.revertDeadlineUtc,
          },
          now: appliedAt,
        }),
      );
      yield* store.apply({
        ...decideMemoryOperation(
          yield* store.loadAggregate(space, memory),
          op,
          Store.hubAdmission,
          { kind: "allowed" },
          undefined,
          undefined,
          0,
        ),
        receipt: ledger.entry.receipt,
        execution: {
          requestedModelSelection: op.resolution.requestedModelSelection,
          effectiveProvider: op.resolution.effectiveProvider,
          effectiveModel: op.resolution.effectiveModel,
          providerInstanceId: op.resolution.requestedModelSelection.instanceId,
          environmentId: env,
        },
      });
      const resolvedConflict = yield* sql<{
        status: string;
      }>`SELECT status FROM memory_conflicts WHERE conflict_id=${op.conflictId}`;
      assert.strictEqual(resolvedConflict[0]!.status, "resolved");
      yield* store.transact(
        store.reconcileOperationReportTx({
          operation: op,
          receipt: ledger.entry.receipt,
          localEnvironmentId: env,
        }),
      );
      const report = (yield* store.pendingReports(100))[0]!;
      yield* store.acknowledgeReport({
        ...report,
        state: "delivered",
        reportThread: { environmentId: env, threadId: M.ThreadId.make("history-report") },
        sequence: 1,
      });
      yield* store.finishWork(
        `resolve:${space}:${ticket.attemptId}`,
        "completed",
        ledger.entry.receipt,
      );
      for (const candidate of yield* store.readDueClaimCandidates(100, 0, space))
        yield* store.completeClaimCandidate(candidate.id);
      const publish = (name: string, at: number, floor: number) =>
        store.transact(
          Effect.gen(function* () {
            const handle = yield* store.prepareHubCheckpointTx({
              authority: { ...leaseAuthority, now: Effect.succeed(at) },
              checkpointId: name,
              snapshotToken: name,
              hubEnvironmentId: env,
            });
            yield* store.publishCheckpointAndFloorTx({
              memorySpaceId: space,
              checkpointId: name,
              expectedFloor: floor,
              nextFloor: handle.checkpointSequence,
              now: at,
            });
            return handle.checkpointSequence;
          }),
        );
      const floor = yield* publish("revert-protected", expiresAt - 1, 0);
      const publishedRows = yield* sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND checkpoint_id='hub:revert-protected' ORDER BY page_ordinal`;
      const produced = yield* Effect.forEach(publishedRows, (row) =>
        decodeCheckpointPage(row.metadata_json),
      );
      assert.isTrue(M.validateMemoryCheckpointRecords(produced));
      assert.isAtMost(
        (yield* store.transact(store.readHubUsageTx(space))).lastSnapshotBytes,
        (yield* store.transact(store.readHubUsageTx(space))).requiredCheckpointBoundBytes,
      );
      const resolveGuard = produced
        .flatMap((page) => page.compactReceipts)
        .find((record) => record.receipt.operationId === op.operationId);
      assert.strictEqual(resolveGuard?.reportGuard?.resolvingEnvironmentId, env);
      assert.strictEqual(produced.flatMap((page) => page.resolutions).length, 1);
      yield* TestClock.adjust(expiresAt - 1);
      assert.strictEqual(
        (yield* store.transact(store.readHubInventoryTx(space))).reclaimable.history,
        0,
      );

      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: floor,
          now: expiresAt - 1,
          limit: 100,
        }),
      );
      for (const revisionId of op.resolution.inputRevisionIds)
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_revisions r JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.revision_id=${revisionId}`)
            .length,
          1,
        );
      if (mode !== "current") {
        const base = operation(996);
        if (base.kind === "forget") throw new Error("fixture");
        const successor = decodeOperation({
          ...base,
          expectedHeads: [op.revision.revisionId],
          revision: { ...base.revision, parents: [op.revision.revisionId] },
        });
        const next = yield* store.transact(
          store.appendHubEntryTx({
            operation: successor,
            operationDigest: memoryOperationDigest(successor),
            outcome: "accepted",
            now: expiresAt,
          }),
        );
        yield* store.apply({
          ...decideMemoryOperation(
            yield* store.loadAggregate(space, memory),
            successor,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
          receipt: next.entry.receipt,
        });
        // Work protects the judgment across one bounded sweep, without pinning the superseded result.
        yield* store.enqueueWork({
          ...backgroundWork("judgment:protected"),
          payloadRef: op.resolution.judgmentRef,
        });
      }
      const nextFloor = yield* publish(
        "revert-expired",
        expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
        floor,
      );
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: nextFloor,
          now: expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
      if (mode !== "current") {
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_revisions WHERE space=${space} AND revision_id=${op.revision.revisionId}`)
            .length,
          0,
        );
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${op.resolution.judgmentRef}`)
            .length,
          1,
        );
        yield* store.finishWork("judgment:protected", "completed");
        const sweepAt = expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS;
        if (mode === "replaced-prune") {
          yield* sql`UPDATE memory_payloads SET purge_eligible_after=${sweepAt} WHERE space=${space} AND payload_ref=${op.resolution.judgmentRef}`;
          yield* store.prunePayloads(sweepAt, 100);
        } else {
          yield* store.transact(
            store.compactEligibleHistoryTx({
              memorySpaceId: space,
              expectedFloor: nextFloor,
              now: sweepAt,
              limit: 100,
            }),
          );
        }
      }
      // Revision identities can outlive their bodies for one bounded sweep while
      // the judgment is still a dependent. Once it is collected, identities can go too.
      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: nextFloor,
          now: expiresAt + M.MEMORY_LOG_RETENTION_MS + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
      for (const revisionId of op.resolution.inputRevisionIds)
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_revisions WHERE space=${space} AND revision_id=${revisionId}`)
            .length,
          0,
        );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.resolution.judgmentRef}`)
          .length,
        0,
      );
      assert.strictEqual((yield* store.loadAggregate(space, memory)).item?.status, "active");
      assert.strictEqual(
        (yield* store.receipt(space, op.operationId))?.receipt.outcome,
        "accepted",
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_report_outbox WHERE state='delivered'`).length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_import_keys WHERE key_kind='report_delivered'`).length,
        1,
      );
      const replay = yield* store.transact(store.readHubReceiptTx(space, op.operationId));
      if (replay?.entry.kind !== "metadata" || !replay.entry.compactReceipt)
        throw new Error("fixture");
      assert.isFalse(
        (yield* store.transact(
          store.reconcileResolutionReportTx({
            record: replay.entry.compactReceipt,
            localEnvironmentId: env,
          }),
        )).deliverable,
      );
      assert.strictEqual((yield* store.pendingReports(100)).length, 0);
      assert.strictEqual(ticket.fencingToken, 1);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "shares required and pinned checkpoint reservation across spaces at equality and rejects plus one",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const other = M.MemorySpaceId.make(id(979));
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - 4097,
          publishedPinnedDeltaBytes: 0,
        }),
      );
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: other,
          checkpointDeltaBytes: 0,
          publishedPinnedDeltaBytes: 1,
        }),
      );
      const failed = yield* store
        .transact(
          store.reserveHubCheckpointTx({
            memorySpaceId: other,
            checkpointDeltaBytes: 4097,
            publishedPinnedDeltaBytes: 0,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "MemoryCapacityError");
      assert.strictEqual((yield* store.transact(store.readHubUsageTx(other))).checkpointBytes, 0);
      const counters = yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_checkpoint'`;
      assert.strictEqual(counters[0]!.value, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - 4096);
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: space,
          checkpointDeltaBytes: -1,
          publishedPinnedDeltaBytes: 0,
        }),
      );
      yield* store.transact(
        store.reserveHubCheckpointTx({
          memorySpaceId: other,
          checkpointDeltaBytes: 4097,
          publishedPinnedDeltaBytes: 0,
        }),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("reserves snapshot growth atomically at pinned equality and rejects one extra byte", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const op = operation(981);
    const append = store.appendHubEntryTx({
      operation: op,
      operationDigest: memoryOperationDigest(op),
      outcome: "rejected",
      failureCode: "identity_mismatch",
      now: 0,
    });
    const base = yield* store.transact(store.readHubUsageTx(space));
    const growth = yield* store
      .transact(
        Effect.gen(function* () {
          yield* append;
          const after = yield* store.readHubUsageTx(space);
          return yield* Effect.fail(
            after.requiredCheckpointBoundBytes - base.requiredCheckpointBoundBytes,
          );
        }),
      )
      .pipe(Effect.flip);
    if (typeof growth !== "number") throw new Error("fixture growth failed");
    assert.isAbove(growth, 0);
    const pins = M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - base.requiredCheckpointBoundBytes - growth;
    yield* store.transact(
      store.reserveHubCheckpointTx({
        memorySpaceId: space,
        checkpointDeltaBytes: 0,
        publishedPinnedDeltaBytes: pins + 1,
      }),
    );
    const failed = yield* store.transact(append).pipe(Effect.flip);
    assert.strictEqual(failed._tag, "MemoryCapacityError");
    assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_operations`).length, 0);
    assert.strictEqual(
      (yield* store.transact(store.readHubUsageTx(space))).requiredCheckpointBoundBytes,
      base.requiredCheckpointBoundBytes,
    );
    yield* store.transact(
      store.reserveHubCheckpointTx({
        memorySpaceId: space,
        checkpointDeltaBytes: 0,
        publishedPinnedDeltaBytes: -1,
      }),
    );
    yield* store.transact(append);
    assert.strictEqual(
      (yield* store.transact(store.readHubUsageTx(space))).stagingBytes,
      M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
    );
    const replay = yield* store.transact(append);
    assert.strictEqual(replay.entry.kind, "metadata");
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["refusal", "forget", "escaped", "pages"] as const)(
  "producer round-trips %s checkpoint and its encoded pages fit the counter bound",
  (shape) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${hash},1,'active')`;
      const first = operation(990);
      const op: M.MemoryOperation =
        shape === "forget"
          ? {
              protocolVersion: 1,
              memorySpaceId: space,
              memoryId: memory,
              operationId: first.operationId,
              originEnvironmentId: env,
              expectedHeads: [],
              kind: "forget",
              tombstone: {
                memorySpaceId: space,
                memoryId: memory,
                deleteOperationId: first.operationId,
                deletingEnvironmentId: env,
                deletedAtUtc: M.MemoryUtcTimestamp.make(now),
                suppressedSourceKeys: Array.from({ length: 20 }, (_, n) => ({
                  environmentId: env,
                  sourceId: M.MemoryImportSourceId.make(id(1700)),
                  sourceItemKey: `${"k".repeat(480)}${n}`,
                })),
                suppressedContent: [],
                sourceExclusions: [],
              },
            }
          : shape === "escaped" && first.kind === "upsert"
            ? {
                ...first,
                payload: { ...first.payload, text: "\u0000".repeat(10000) },
              }
            : first;
      yield* store.transact(
        Effect.gen(function* () {
          const ledger = yield* store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome:
              shape === "refusal" || shape === "pages"
                ? "rejected"
                : shape === "forget"
                  ? "deleted"
                  : "accepted",
            ...(shape === "refusal" || shape === "pages"
              ? { failureCode: "identity_mismatch" as const }
              : {}),
            now: 0,
          });
          if (shape !== "refusal" && shape !== "pages") {
            const decided = decideMemoryOperation(
              yield* store.loadAggregate(space, memory),
              op,
              Store.hubAdmission,
              scanMemoryValue(op),
            );
            yield* store.apply({ ...decided, receipt: ledger.entry.receipt });
          } else {
            assert.strictEqual(ledger.entry.kind, "metadata");
            if (ledger.entry.kind === "metadata") assert.isDefined(ledger.entry.compactReceipt);
          }
        }),
      );
      if (shape === "pages") {
        for (let n = 0; n < 105; n++) {
          const rejected = operation(1100 + n);
          yield* store.transact(
            store.appendHubEntryTx({
              operation: rejected,
              operationDigest: memoryOperationDigest(rejected),
              outcome: "rejected",
              failureCode: "identity_mismatch",
              now: 0,
            }),
          );
        }
      }
      const authority: Store.HubAuthority = {
        principal: {
          memorySpaceId: space,
          environmentId: env,
          credentialVersion: 1,
          scopes: ["memory:sync"],
        },
        now: Clock.currentTimeMillis,
        reauthorize: Effect.void,
      };
      const handle = yield* store.transact(
        store.prepareHubCheckpointTx({
          authority,
          checkpointId: `shape-${shape}`,
          snapshotToken: `token-${shape}`,
          hubEnvironmentId: env,
        }),
      );
      const pages: M.MemoryHubCheckpointPage[] = [];
      let cursor: M.MemoryHubCheckpointPage["nextCursor"] = null;
      for (let i = 0; i < handle.pageCount; i++) {
        const page: M.MemoryHubCheckpointPage = yield* store.transact(
          store.readHubCheckpointPageTx({
            authority,
            snapshotToken: handle.snapshotToken,
            cursor,
          }),
        );
        const json = yield* encodeCheckpointPage(page);
        pages.push(yield* decodeCheckpointPage(json));
        cursor = page.nextCursor;
      }
      assert.isTrue(M.validateMemoryCheckpointRecords(pages));
      const usage = yield* store.transact(store.readHubUsageTx(space));
      assert.isAtMost(usage.lastSnapshotBytes, usage.requiredCheckpointBoundBytes);
      assert.strictEqual(
        pages.flatMap((p) => p.compactReceipts).length,
        shape === "pages" ? 106 : 1,
      );
      if (shape === "pages") assert.isAbove(handle.pageCount, 1);
      if (shape === "escaped") assert.isAbove(usage.lastSnapshotBytes, 100000);
      assert.strictEqual(
        pages.flatMap((p) => p.identities).length,
        shape === "refusal" || shape === "pages" ? 0 : 1,
      );
      if (shape === "forget") {
        assert.strictEqual(pages.flatMap((p) => p.tombstones).length, 1);
        assert.strictEqual(pages.flatMap((p) => p.suppressions).length, 20);
      }
      const replay = yield* store.transact(store.readHubReceiptTx(space, op.operationId));
      assert.strictEqual(
        replay?.entry.receipt.outcome,
        shape === "refusal" || shape === "pages"
          ? "rejected"
          : shape === "forget"
            ? "deleted"
            : "accepted",
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "compacts acknowledged admin after thirty days into an immutable replay and secret-name guard",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first: Store.AdminRecord = {
        requestId: M.MemoryOperationId.make(id(995)),
        requestDigest: hash,
        expectedVersion: 0,
        stage: "prepared",
        action: {
          action: "configure",
          requestId: M.MemoryOperationId.make(id(995)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        secretName: "synthetic-secret-name",
        result: null,
        memberVersion: null,
      };
      yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
      yield* store.transact(
        store.writeHubAdminTx({
          record: { ...first, stage: "activated" },
          expectedStage: "prepared",
        }),
      );
      const ready: Store.AdminRecord = {
        ...first,
        stage: "ready",
        result: { view: { provenance: null, settings: { mode: "disabled" }, version: 1 } },
      };
      yield* store.transact(store.writeHubAdminTx({ record: ready, expectedStage: "activated" }));
      const terminal = yield* store.transact(
        store.writeHubAdminTx({
          record: { ...ready, stage: "acknowledged" },
          expectedStage: "ready",
        }),
      );
      const reservedCounters = yield* sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND dimension IN ('hub_receipts','hub_keys') ORDER BY dimension`;
      assert.deepStrictEqual(reservedCounters, [
        { dimension: "hub_keys", value: 1 },
        { dimension: "hub_receipts", value: 1 },
      ]);
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: M.MEMORY_LOG_RETENTION_MS - 1,
          limit: 100,
        }),
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 1);
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.purgeHubTransientTx({
              memorySpaceId: space,
              now: M.MEMORY_LOG_RETENTION_MS,
              limit: 100,
            });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 1);
      yield* store.transact(
        store.purgeHubTransientTx({
          memorySpaceId: space,
          now: M.MEMORY_LOG_RETENTION_MS,
          limit: 100,
        }),
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 0);
      assert.deepStrictEqual(
        yield* sql`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND dimension IN ('hub_receipts','hub_keys') ORDER BY dimension`,
        reservedCounters,
      );
      const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
      const guard = yield* fresh.transact(fresh.readHubAdminTx(first.requestId));
      assert.isDefined(guard);
      assert.isFalse(guard !== undefined && "action" in guard);
      assert.strictEqual(guard?.secretName, first.secretName);
      assert.deepStrictEqual(guard?.result, terminal.result);
      assert.deepStrictEqual(
        yield* fresh.transact(fresh.writeHubAdminTx({ record: first, expectedStage: null })),
        terminal,
      );
      assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin'`).length, 0);
      const mismatch = yield* fresh
        .transact(
          fresh.writeHubAdminTx({
            record: { ...first, secretName: "different-secret" },
            expectedStage: null,
          }),
        )
        .pipe(Effect.flip);
      assert.strictEqual(mismatch._tag, "MemoryStoreConflict");
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("keeps the successor frontier and exposure on body-free canonical metadata replay", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const first = operation();
    const second = childOperation();
    if (first.kind === "forget" || second.kind === "forget") throw new Error("fixture");
    for (const [index, op] of [first, second].entries()) {
      const approval: M.MemoryHubReceipt = {
        operationId: op.operationId,
        memoryId: memory,
        operationDigest: memoryOperationDigest(op),
        outcome: "accepted",
        hubSequence: index + 1,
      };
      yield* store.apply(
        decideMemoryOperation(
          yield* store.loadAggregate(space, memory),
          op,
          Store.approvedReplica,
          { kind: "allowed" },
          approval,
        ),
      );
    }
    const scanner = (yield* store.readDeferred(0, 100)).find((row) => row.kind === "scanner")!;
    assert.isDefined(scanner);
    const scanned = yield* store.readScannerChunk(scanner);
    assert.isNull(scanned.nextCursor);
    assert.strictEqual(scanMemoryValue({ payloads: scanned.payloads }).kind, "allowed");
    assert.isTrue(yield* store.claimDeferred(scanner, "replay-scanner", 0, 1000));
    assert.isTrue(
      yield* store.finishOwnedDeferred(scanner, "replay-scanner", 1000, {
        now: 0,
        scannerPolicyVersion: 1,
      }),
    );
    const before = yield* store.loadAggregate(space, memory);
    assert.deepStrictEqual(before.heads, [second.revision.revisionId]);
    assert.strictEqual(before.item?.localAvailability.exposure, "visible");
    yield* sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref=${first.revision.payloadRef}`;
    const receipt = (yield* store.receipt(space, first.operationId))!.receipt;
    if (!("hubSequence" in receipt) || receipt.hubSequence === null) throw new Error("fixture");
    yield* store.transact(
      store.settleMetadataEntryTx({
        memorySpaceId: space,
        entry: {
          kind: "metadata",
          operationKind: "upsert",
          memoryId: memory,
          hubSequence: 1,
          receipt,
          revision: first.revision,
        },
      }),
    );
    const after = yield* store.loadAggregate(space, memory);
    assert.deepStrictEqual(after.heads, [second.revision.revisionId]);
    assert.deepStrictEqual(after.item, before.item);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "finds activated admin beyond a saturated ready list and excludes acknowledged records",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const make = (n: number): Store.AdminRecord => ({
        requestId: M.MemoryOperationId.make(id(n)),
        requestDigest: hash,
        expectedVersion: 0,
        stage: "prepared",
        action: {
          action: "configure",
          requestId: M.MemoryOperationId.make(id(n)),
          expectedVersion: 0,
          settings: { mode: "disabled" },
        },
        secretName: null,
        memberVersion: null,
        result: null,
      });
      assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
      for (let n = 0; n <= M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS; n++) {
        const record = make(2000 + n);
        yield* store.transact(store.writeHubAdminTx({ record, expectedStage: null }));
        yield* store.transact(
          store.writeHubAdminTx({
            record: { ...record, stage: "activated" },
            expectedStage: "prepared",
          }),
        );
        const ready: Store.AdminRecord = {
          ...record,
          stage: "ready",
          result: { view: { provenance: null, settings: { mode: "disabled" }, version: 1 } },
        };
        yield* store.transact(store.writeHubAdminTx({ record: ready, expectedStage: "activated" }));
        if (n === 0)
          yield* store.transact(
            store.writeHubAdminTx({
              record: { ...ready, stage: "acknowledged" },
              expectedStage: "ready",
            }),
          );
      }
      assert.isUndefined(yield* store.transact(store.readActivatedHubAdminTx()));
      const prepared = make(3000);
      yield* store.transact(store.writeHubAdminTx({ record: prepared, expectedStage: null }));
      const target = make(4000);
      yield* store.transact(store.writeHubAdminTx({ record: target, expectedStage: null }));
      const activated: Store.AdminRecord = { ...target, stage: "activated" };
      yield* store.transact(
        store.writeHubAdminTx({ record: activated, expectedStage: "prepared" }),
      );
      assert.isFalse(
        (yield* store.readPendingHubAdmins(M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)).some(
          (r) => r.requestId === activated.requestId,
        ),
      );
      assert.deepStrictEqual(yield* store.transact(store.readActivatedHubAdminTx()), activated);
      const fresh = yield* Effect.service(Store.MemoryStore).pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(yield* fresh.transact(fresh.readActivatedHubAdminTx()), activated);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_outbox WHERE kind='admin' AND json_extract(admin_json,'$.stage')='acknowledged'`)
          .length,
        1,
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("recovery preserves stale submissions while discovering unrelated claims", () =>
  Effect.gen(function* () {
    const { store, sql, ticket, key, ownership, submission } = yield* seedSubmission;
    const submitted = yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(submission.operation),
      }),
    );
    // A second memory becomes quarantined while the first submission is in flight.
    const other = M.MemoryId.make(id(980));
    const aggregate = yield* store.loadAggregate(space, memory);
    if (aggregate.item?.status !== "quarantined") throw new Error("fixture");
    const item = {
      ...aggregate.item,
      memoryId: other,
      conflict: { ...aggregate.item.conflict, memoryId: other },
    };
    yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) SELECT space,${other},scope_json,scope_key,heads_json,status,projection_watermark,${JSON.stringify(item)},availability_json FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
    yield* store.recoverClaimCandidates(0);
    const rows = yield* sql<{
      status: string;
      ticket_json: string;
    }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
    assert.strictEqual(rows[0]!.status, "pending");
    assert.strictEqual(JSON.parse(rows[0]!.ticket_json).state, "submitting");
    assert.isNotNull(JSON.parse(rows[0]!.ticket_json).submission);
    assert.isTrue(
      (yield* store.readDueClaimCandidates(100, 0, space)).some((c) => c.memoryId === other),
    );
    const changed = {
      ...aggregate.item,
      conflict: {
        ...aggregate.item.conflict,
        heads: [M.MemoryRevisionId.make(id(981)), M.MemoryRevisionId.make(id(982))],
      },
    };
    yield* sql`UPDATE memory_items SET item_json=${JSON.stringify(changed)},heads_json=${JSON.stringify(changed.conflict.heads)} WHERE space=${space} AND memory_id=${memory}`;
    yield* store.recoverClaimCandidates(1);
    const stale = yield* sql<{
      status: string;
      ticket_json: string;
    }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
    assert.strictEqual(stale[0]!.status, "pending");
    const retained = JSON.parse(stale[0]!.ticket_json);
    assert.strictEqual(retained.state, "submitting");
    assert.strictEqual(retained.owner, "fixture");
    assert.isNotNull(retained.submission);
    assert.isTrue(retained.reconcileRequired);
    assert.isNull(
      yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: submitted.version,
          owner: "late",
          coordinatorEpoch: 2,
          now: 101,
          ownedUntil: 200,
        }),
      ),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${`submission:${ticket.attemptId}`}`)
        .length,
      1,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "bootstrap restart reads persisted progress and expired staging discard fences a newer join",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const input = { memorySpaceId: space, hubEnvironmentId: env };
      assert.strictEqual((yield* store.readBootstrap(input)).state, "unbound");
      yield* store.transact(
        store.advanceBootstrapTx({
          ...input,
          expectedState: "unbound",
          nextState: "staging",
          checkpointId: "stage-old",
          snapshotToken: "synthetic-old",
          checkpointSequence: 1,
          nextCursor: null,
        }),
      );
      yield* store.transact(
        Effect.gen(function* () {
          yield* store.installCheckpointPage({
            memorySpaceId: space,
            hubEnvironmentId: env,
            expectedSnapshotToken: "synthetic-old",
            expectedCheckpointSequence: 1,
            checkpointId: "stage-old",
            page: checkpoint(),
          });
          yield* store.advanceBootstrapTx({
            ...input,
            expectedState: "staging",
            nextState: "staging",
            checkpointId: "stage-old",
            snapshotToken: "synthetic-old",
            checkpointSequence: 1,
            nextCursor: "next-page",
          });
        }),
      );
      const recovered = yield* store.readBootstrap(input).pipe(Effect.provide(Store.layer));
      assert.deepStrictEqual(recovered, {
        state: "staging",
        checkpointId: "stage-old",
        snapshotToken: "synthetic-old",
        checkpointSequence: 1,
        cursor: "next-page",
        pageCount: 1,
        afterSequence: 0,
        lastSuccessAt: null,
      });
      const discard = {
        ...input,
        expectedSnapshotToken: "synthetic-old",
        expectedCheckpointId: "stage-old",
        expectedCheckpointSequence: 1,
      };
      assert.isFalse(
        yield* store.transact(
          store.discardBootstrapTx({ ...discard, expectedSnapshotToken: "wrong" }),
        ),
      );
      yield* store
        .transact(store.discardBootstrapTx(discard).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* store.readBootstrap(input), recovered);
      assert.isTrue(yield* store.transact(store.discardBootstrapTx(discard)));
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='stage-old'`).length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE checkpoint_stage_id='stage-old'`).length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${memory}`).length,
        0,
      );
      yield* store.transact(
        store.advanceBootstrapTx({
          ...input,
          expectedState: "unbound",
          nextState: "staging",
          checkpointId: "stage-new",
          snapshotToken: "synthetic-new",
          checkpointSequence: 2,
          nextCursor: null,
        }),
      );
      assert.isFalse(yield* store.transact(store.discardBootstrapTx(discard)));
      assert.strictEqual((yield* store.readBootstrap(input)).snapshotToken, "synthetic-new");
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "definitive ticketless claim retirement CAS preserves changed generations heads attempts and tickets",
  () =>
    Effect.gen(function* () {
      const { store, claim } = yield* seedResolutionConflict;
      yield* store.recoverClaimCandidates(0);
      const candidate = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
      yield* store.transact(
        store.prepareClaimAttemptTx({
          memorySpaceId: space,
          candidateId: candidate.id,
          expectedGeneration: 0,
          conflictHeads: claim.conflictHeadSet,
          proposedClaim: claim,
        }),
      );
      const retirement = {
        memorySpaceId: space,
        candidateId: candidate.id,
        expectedGeneration: 0,
        attemptId: claim.attemptId,
        frozenHeads: claim.conflictHeadSet,
        nextAttemptAt: 0,
      };
      assert.isFalse(
        yield* store.transact(store.retireFrozenClaimTx({ ...retirement, expectedGeneration: 1 })),
      );
      assert.isFalse(
        yield* store.transact(
          store.retireFrozenClaimTx({
            ...retirement,
            attemptId: M.MemoryOperationId.make(id(990)),
          }),
        ),
      );
      assert.isFalse(
        yield* store.transact(
          store.retireFrozenClaimTx({
            ...retirement,
            frozenHeads: [M.MemoryRevisionId.make(id(991))],
          }),
        ),
      );
      yield* store
        .transact(
          store.retireFrozenClaimTx(retirement).pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.flip);
      assert.isTrue(yield* store.transact(store.retireFrozenClaimTx(retirement)));
      assert.isFalse(yield* store.transact(store.retireFrozenClaimTx(retirement)));
      const nextClaim = {
        ...claim,
        attemptId: M.MemoryOperationId.make(id(992)),
        frozenDefaultModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
      };
      assert.deepStrictEqual(
        yield* store.transact(
          store.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: 1,
            conflictHeads: claim.conflictHeadSet,
            proposedClaim: nextClaim,
          }),
        ),
        { claim: nextClaim, generation: 1 },
      );
      const ticket = yield* store.transact(
        store.transitionHubLeaseTx({
          authority: leaseAuthority,
          action: { kind: "claim", request: nextClaim },
        }),
      );
      if (!ticket || "released" in ticket) throw new Error("fixture");
      yield* store.persistResolutionTicket(ticket);
      assert.isFalse(
        yield* store.transact(
          store.retireFrozenClaimTx({
            ...retirement,
            expectedGeneration: 1,
            attemptId: nextClaim.attemptId,
          }),
        ),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "processing reads durable counters exactly across restart status transitions and rollback without table scans",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const input = { memorySpaceId: space, hubEnvironmentId: env };
      const empty = yield* store.readProcessing(input);
      assert.strictEqual(empty.processing.deferred, 0);
      assert.strictEqual(empty.processing.oldestDeferredAtUtc, null);
      yield* store.apply(decision());
      const since = "2026-10-13T00:00:00.000Z";
      const later = "2026-10-14T00:00:00.000Z";
      const deferred = [
        {
          kind: "index",
          state: "pending",
          reason: null,
          revisionId: null,
          generation: 0,
          sinceAtUtc: later,
        },
        {
          kind: "scanner",
          state: "held",
          reason: "secret_detected",
          revisionId: null,
          generation: 0,
          sinceAtUtc: since,
        },
      ];
      yield* sql`UPDATE memory_items SET deferred_json=${JSON.stringify(deferred)},availability_json='{"exposure":"held","reasons":["secret_detected","scanner_pending","missing_parent"],"deferred":[],"cleanupPending":true}',cleanup_pending=1 WHERE space=${space}`;
      yield* sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,missing_parents_json,reason,metadata_json) VALUES (${space},'parked','operation','[]','missing_parent','{}')`;
      yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolving_environment_id,outcome,state,failure_code,created_at) VALUES ('report',${space},${memory},${id(999)},${env},'failed','failed','scanner_pending',0)`;
      yield* store.withReceivedCursor(
        { ...input, afterSequence: 7, expectedSequence: 0 },
        Effect.void,
      );
      const before = yield* store.readProcessing(input).pipe(Effect.provide(Store.layer));
      assert.strictEqual(before.pendingSync, 1);
      assert.strictEqual(before.parked, 1);
      assert.strictEqual(before.processing.lastReceivedHubSequence, 7);
      assert.strictEqual(before.processing.deferred, 2);
      assert.strictEqual(before.processing.oldestDeferredAtUtc, since);
      assert.strictEqual(before.processing.scannerHeldItems, 1);
      assert.strictEqual(before.processing.scannerPendingItems, 1);
      assert.strictEqual(before.processing.missingParentItems, 1);
      assert.strictEqual(before.processing.pendingCleanupItems, 1);
      assert.strictEqual(before.processing.reportBacklog, 1);
      assert.strictEqual(before.processing.reportFailed, 1);
      assert.deepStrictEqual(before.processing.indexCoverage, {
        status: "unavailable",
        eligibleItems: 1,
        indexedItems: 0,
        unindexedItems: 1,
        projectionWatermark: 1,
      });
      yield* store
        .transact(
          sql`DELETE FROM memory_items WHERE space=${space}`.pipe(
            Effect.andThen(Effect.fail("rollback")),
          ),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* store.readProcessing(input), before);
      yield* sql`UPDATE memory_items SET index_state='ready',indexed_generation=generation,deferred_json=${JSON.stringify([deferred[0]])},cleanup_pending=0 WHERE space=${space}`;
      const next = yield* store.readProcessing(input);
      assert.strictEqual(next.processing.deferred, 1);
      assert.strictEqual(next.processing.oldestDeferredAtUtc, later);
      assert.strictEqual(next.processing.unindexedItems, 0);
      yield* sql`UPDATE memory_items SET deferred_json='[]' WHERE space=${space}`;
      assert.strictEqual((yield* store.readProcessing(input)).processing.oldestDeferredAtUtc, null);
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT processing_oldest_at FROM memory_items WHERE space=${space} AND processing_oldest_at IS NOT NULL ORDER BY processing_oldest_at LIMIT 1`;
      assert.isTrue(plan.some((r) => r.detail.includes("memory_processing_oldest")));
      assert.isFalse(
        plan.some((r) => r.detail.includes("SCAN") || r.detail.includes("TEMP B-TREE")),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "exposure cancellation fences ticket ownership and resumes the same frontier after the hold clears",
  () =>
    Effect.gen(function* () {
      const { store, sql, ticket } = yield* seedSubmission;
      yield* store.recoverClaimCandidates(0);
      const aggregate = yield* store.loadAggregate(space, memory);
      if (!aggregate.item) throw new Error("fixture");
      const held = {
        ...aggregate.item,
        localAvailability: { ...aggregate.item.localAvailability, reasons: ["scanner_pending"] },
      };
      yield* sql`UPDATE memory_items SET item_json=${JSON.stringify(held)} WHERE space=${space} AND memory_id=${memory}`;
      yield* store.recoverClaimCandidates(1);
      const cancelled = yield* sql<{
        status: string;
        ticket_json: string;
      }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.strictEqual(cancelled[0]!.status, "cancelled");
      assert.strictEqual(JSON.parse(cancelled[0]!.ticket_json).state, "terminal");
      assert.strictEqual((yield* store.readDueClaimCandidates(100, 1, space)).length, 0);
      yield* sql`UPDATE memory_items SET item_json=${JSON.stringify(aggregate.item)} WHERE space=${space} AND memory_id=${memory}`;
      yield* store.recoverClaimCandidates(2);
      const candidate = (yield* store.readDueClaimCandidates(100, 2, space))[0]!;
      assert.strictEqual(candidate.status, "pending");
      if (candidate.metadata.kind !== "claim") throw new Error("fixture");
      assert.isTrue(candidate.metadata.generation! > 0);
      assert.strictEqual(
        (yield* sql<{
          status: string;
        }>`SELECT status FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`)[0]!
          .status,
        "cancelled",
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("discarding expired bootstrap preserves staged bodies adopted by canonical receive", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const input = { memorySpaceId: space, hubEnvironmentId: env };
    yield* store.transact(
      store.advanceBootstrapTx({
        ...input,
        expectedState: "unbound",
        nextState: "staging",
        checkpointId: "adopted",
        snapshotToken: "synthetic-adopted",
        checkpointSequence: 1,
        nextCursor: null,
      }),
    );
    yield* store.installCheckpointPage({
      memorySpaceId: space,
      hubEnvironmentId: env,
      expectedSnapshotToken: "synthetic-adopted",
      expectedCheckpointSequence: 1,
      checkpointId: "adopted",
      page: checkpoint(),
    });
    yield* store.apply(approved());
    assert.isTrue(
      yield* store.transact(
        store.discardBootstrapTx({
          ...input,
          expectedSnapshotToken: "synthetic-adopted",
          expectedCheckpointId: "adopted",
          expectedCheckpointSequence: 1,
        }),
      ),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${id(13)}`)
        .length,
      1,
    );
    const canonical = yield* store.loadAggregate(space, memory);
    assert.strictEqual(canonical.item?.status, "blocked");
    assert.include(canonical.item!.localAvailability.reasons, "scanner_pending");
    assert.include(canonical.heads, M.MemoryRevisionId.make(id(13)));
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["recoverable", "running", "submitting", "approved", "finalizing"] as const)(
  "current frontier recovery preserves ticket state and ownership: %s",
  (state) =>
    Effect.gen(function* () {
      const { store, sql, ticket, ownership, submission } = yield* seedSubmission;
      if (state === "submitting" || state === "approved" || state === "finalizing") {
        yield* store.transact(
          store.persistResolutionSubmissionTx({
            ownership,
            submission,
            digest: memoryOperationDigest(submission.operation),
          }),
        );
      }
      if (submission.operation.kind !== "resolve") throw new Error("fixture");
      const current = yield* sql<{
        ticket_json: string;
      }>`SELECT ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      const saved = JSON.parse(current[0]!.ticket_json);
      saved.state = state;
      if (state === "approved" || state === "finalizing")
        saved.approval = {
          operationId: submission.operation.operationId,
          memoryId: memory,
          operationDigest: memoryOperationDigest(submission.operation),
          outcome: "accepted",
          hubSequence: 1,
          resolutionApproval: {
            resolutionId: submission.operation.resolution.resolutionId,
            appliedAtUtc: now,
            revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
          },
        };
      yield* sql`UPDATE memory_outbox SET ticket_json=${JSON.stringify(saved)} WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      yield* store.recoverClaimCandidates(0);
      const rows = yield* sql<{
        status: string;
        ticket_json: string;
        sync_version: number;
      }>`SELECT status,ticket_json,sync_version FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.strictEqual(rows[0]!.status, "pending");
      assert.deepStrictEqual(JSON.parse(rows[0]!.ticket_json), saved);
      assert.strictEqual(rows[0]!.sync_version, saved.version);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "orphan recovery cancels outbox and ticket in the same transaction and rolls back together",
  () =>
    Effect.gen(function* () {
      const { store, sql, ticket } = yield* seedSubmission;
      yield* sql`DELETE FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
      yield* store
        .transact(store.recoverClaimCandidates(0).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.flip);
      const before = yield* sql<{
        status: string;
        ticket_json: string;
      }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.strictEqual(before[0]!.status, "pending");
      assert.strictEqual(JSON.parse(before[0]!.ticket_json).owner, "fixture");
      yield* store.recoverClaimCandidates(0);
      const after = yield* sql<{
        status: string;
        ticket_json: string;
      }>`SELECT status,ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.strictEqual(after[0]!.status, "cancelled");
      assert.strictEqual(JSON.parse(after[0]!.ticket_json).state, "terminal");
      assert.isNull(JSON.parse(after[0]!.ticket_json).owner);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("space selectors reach B behind 100 earlier A candidates and tickets", () =>
  Effect.gen(function* () {
    const { store, sql, claim } = yield* seedResolutionConflict;
    yield* store.recoverClaimCandidates(0);
    const candidate = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
    const ticket = yield* store.transact(
      store.transitionHubLeaseTx({
        authority: leaseAuthority,
        action: { kind: "claim", request: claim },
      }),
    );
    if (!ticket || "released" in ticket) throw new Error("fixture");
    yield* store.persistResolutionTicket(ticket);
    const b = M.MemorySpaceId.make(id(9000));
    yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) SELECT ${b},memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
    const frozen = { ...claim, memorySpaceId: b };
    yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at,attempt,frozen_claim_json) SELECT 'b-candidate',${b},memory_id,kind,status,metadata_json,1,attempt,${JSON.stringify(frozen)} FROM memory_outbox WHERE id=${candidate.id}`;
    yield* store.persistResolutionTicket({
      ...ticket,
      memorySpaceId: b,
      attemptId: M.MemoryOperationId.make(id(9001)),
    });
    for (let n = 0; n < 100; n++) {
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at,attempt) SELECT ${`a-candidate:${n}`},space,memory_id,kind,status,metadata_json,0,attempt FROM memory_outbox WHERE id=${candidate.id}`;
      yield* store.persistResolutionTicket({
        ...ticket,
        attemptId: M.MemoryOperationId.make(id(9100 + n)),
      });
    }
    const candidates = yield* store.readDueClaimCandidates(100, 1, b);
    assert.deepStrictEqual(
      candidates.map((c) => c.id),
      ["b-candidate"],
    );
    const tickets = yield* store.readRecoverableResolutionTickets({
      memorySpaceId: b,
      now: 1,
      limit: 100,
    });
    assert.deepStrictEqual(
      tickets.map((t) => t.ticket.memorySpaceId),
      [b],
    );
    const keyed = { memorySpaceId: b, candidateId: "b-candidate", attemptId: claim.attemptId };
    assert.strictEqual((yield* store.findClaimCandidate(keyed))?.id, "b-candidate");
    assert.isNull(yield* store.findClaimCandidate({ ...keyed, memorySpaceId: space }));
    assert.isNull(
      yield* store.findClaimCandidate({ ...keyed, attemptId: M.MemoryOperationId.make(id(9999)) }),
    );
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT id FROM memory_outbox WHERE space=${b} AND kind='claim' AND status IN ('pending','retry') AND next_attempt_at<=1`;
    assert.isTrue(plan.some((r) => r.detail.includes("memory_outbox_sync_due")));
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("resolution snapshot SQL rows and bytes stay constant as history grows", () =>
  Effect.gen(function* () {
    const { sql, claim } = yield* seedResolutionConflict;
    let measuring = false;
    let rowsRead = 0;
    let bytesRead = 0;
    const observed = new Proxy(sql, {
      apply(target, _this, args) {
        const statement: Statement.Statement<object> = Reflect.apply(target, target, args);
        return Object.assign(
          Effect.tap(statement, (rows) =>
            Effect.sync(() => {
              if (measuring) {
                rowsRead += rows.length;
                bytesRead += new TextEncoder().encode(JSON.stringify(rows)).length;
              }
            }),
          ),
          Statement.fragment(statement.segments),
        );
      },
    });
    const store = yield* Effect.service(Store.MemoryStore).pipe(
      Effect.provide(Layer.fresh(Store.layer)),
      Effect.provideService(SqlClient.SqlClient, observed),
    );
    measuring = true;
    yield* store.readResolutionSnapshot(space, memory);
    measuring = false;
    const before = { rows: rowsRead, bytes: bytesRead };
    for (let n = 0; n < 100; n++) {
      yield* sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) SELECT space,${id(20000 + n)},memory_id,${id(21000 + n)},parents_json,scope_json,assertion_kind,provenance_json,NULL,created_at FROM memory_revisions WHERE space=${space} AND revision_id=${claim.conflictHeadSet[0]}`;
      yield* sql`INSERT INTO memory_conflicts(space,conflict_id,memory_id,heads_json,status,failure_code) SELECT space,${id(22000 + n)},memory_id,heads_json,status,failure_code FROM memory_conflicts WHERE space=${space} LIMIT 1`;
    }
    rowsRead = 0;
    bytesRead = 0;
    measuring = true;
    const after = yield* store.readResolutionSnapshot(space, memory);
    measuring = false;
    assert.deepStrictEqual({ rows: rowsRead, bytes: bytesRead }, before);
    assert.strictEqual(rowsRead, 1);
    assert.isBelow(bytesRead, 2048);
    assert.strictEqual(after.status, "quarantined");
    assert.deepStrictEqual(after.heads, claim.conflictHeadSet);
    const heads = yield* store.readResolutionHeads({
      expectedGeneration: after.generation,
      maxItems: 100,
      maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      memorySpaceId: space,
      memoryId: memory,
      heads: claim.conflictHeadSet,
    });
    for (const budget of [
      {
        expectedGeneration: after.generation + 1,
        maxItems: 100,
        maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      },
      {
        expectedGeneration: after.generation,
        maxItems: 1,
        maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
      },
      { expectedGeneration: after.generation, maxItems: 100, maxBytes: 1 },
    ]) {
      assert.strictEqual(
        (yield* store
          .readResolutionHeads({
            memorySpaceId: space,
            memoryId: memory,
            heads: claim.conflictHeadSet,
            ...budget,
          })
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
    }
    const exactBytes = new TextEncoder().encode(JSON.stringify(heads)).length;
    assert.deepStrictEqual(
      yield* store.readResolutionHeads({
        memorySpaceId: space,
        memoryId: memory,
        heads: claim.conflictHeadSet,
        expectedGeneration: after.generation,
        maxItems: 2,
        maxBytes: exactBytes,
      }),
      heads,
    );
    assert.strictEqual(
      (yield* store
        .readResolutionHeads({
          memorySpaceId: space,
          memoryId: memory,
          heads: claim.conflictHeadSet,
          expectedGeneration: after.generation,
          maxItems: 2,
          maxBytes: exactBytes - 1,
        })
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.strictEqual(heads.length, 2);
    assert.isTrue(heads.every((h) => h.payload !== null));
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT r.revision_id,p.body_json FROM json_each(${JSON.stringify(claim.conflictHeadSet)}) selected CROSS JOIN memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.revision_id=selected.value AND r.memory_id=${memory}`;
    assert.isTrue(
      plan.some((row) =>
        row.detail.includes("SEARCH r USING INDEX sqlite_autoindex_memory_revisions_1"),
      ),
    );
    assert.isFalse(plan.some((row) => row.detail.includes("SCAN r")));

    assert.strictEqual(
      (yield* store
        .readResolutionHeads({
          expectedGeneration: after.generation,
          maxItems: 100,
          maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
          memorySpaceId: space,
          memoryId: memory,
          heads: [M.MemoryRevisionId.make(id(20000))],
        })
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    yield* sql`DELETE FROM memory_payloads WHERE space=${space}`;
    assert.deepStrictEqual(yield* store.readResolutionSnapshot(space, memory), after);
    assert.isTrue(
      (yield* store.readResolutionHeads({
        expectedGeneration: after.generation,
        maxItems: 100,
        maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
        memorySpaceId: space,
        memoryId: memory,
        heads: claim.conflictHeadSet,
      })).every((h) => h.payload === null),
    );
    yield* sql`INSERT INTO memory_pending_forget_intents(space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,submission_state) VALUES (${space},${memory},${id(23000)},${now},0,NULL,'unsubmitted')`;
    assert.isTrue((yield* store.readResolutionSnapshot(space, memory)).pendingForget);
    assert.strictEqual(
      (yield* store
        .readResolutionHeads({
          expectedGeneration: after.generation,
          maxItems: 100,
          maxBytes: M.MEMORY_DEFERRED_SWEEP_MAX_BYTES,
          memorySpaceId: space,
          memoryId: memory,
          heads: claim.conflictHeadSet,
        })
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("rearms only the persisted sync hold class and fences the old owner", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const op = operation();
    yield* store.apply(decision(op));
    const candidate = (yield* store.readEligibleOutbox(space, 0, 10))[0]!;
    const ownership = yield* store.transact(
      store.acquireSyncWorkTx({
        workId: candidate.work.id,
        operationId: candidate.operationId,
        operationDigest: candidate.operationDigest,
        owner: "old",
        expectedVersion: candidate.version,
        now: 0,
        ownedUntil: 100,
      }),
    );
    if (!ownership) throw new Error("fixture");
    assert.isTrue(
      yield* store.transact(
        store.retrySyncWorkTx({
          ownership,
          now: 1,
          nextAttemptAt: Number.MAX_SAFE_INTEGER,
          failureCode: "identity_mismatch",
          holdClass: "identity",
        }),
      ),
    );
    yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at,hold_class,failure_code) SELECT 'protocol-hold',space,memory_id,kind,status,metadata_json,next_attempt_at,'protocol','unsupported_protocol' FROM memory_outbox WHERE id=${candidate.work.id}`;
    const fresh = yield* Effect.service(Store.MemoryStore).pipe(
      Effect.provide(Layer.fresh(Store.layer)),
    );
    assert.deepStrictEqual(yield* fresh.readWorkHold(candidate.work.id), {
      holdClass: "identity",
      failureCode: "identity_mismatch",
    });
    assert.deepStrictEqual(
      (yield* fresh.transact(
        fresh.rearmSyncHoldsTx({
          memorySpaceId: M.MemorySpaceId.make(id(7777)),
          holdClass: "identity",
          now: 2,
          afterId: "",
          limit: 100,
        }),
      )).changedIds,
      [],
    );
    yield* fresh
      .transact(
        Effect.gen(function* () {
          yield* fresh.rearmSyncHoldsTx({
            memorySpaceId: space,
            holdClass: "identity",
            now: 2,
            afterId: "",
            limit: 100,
          });
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.exit);
    assert.strictEqual((yield* fresh.readWorkHold(candidate.work.id))?.holdClass, "identity");
    assert.deepStrictEqual(
      (yield* fresh.transact(
        fresh.rearmSyncHoldsTx({
          memorySpaceId: space,
          holdClass: "identity",
          now: 2,
          afterId: "",
          limit: 100,
        }),
      )).changedIds,
      [candidate.work.id],
    );
    assert.deepStrictEqual(yield* fresh.readWorkHold(candidate.work.id), {
      holdClass: null,
      failureCode: null,
    });
    assert.strictEqual((yield* fresh.readWorkHold("protocol-hold"))?.holdClass, "protocol");
    assert.isFalse(
      yield* fresh.transact(
        fresh.retrySyncWorkTx({ ownership, now: 3, nextAttemptAt: 4, failureCode: "unavailable" }),
      ),
    );
    assert.strictEqual((yield* fresh.readEligibleOutbox(space, 2, 100)).length, 1);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("pull bootstrap retry survives restart with version CAS and untouched cursor", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const key = { memorySpaceId: space, hubEnvironmentId: env };
    assert.deepStrictEqual(yield* store.readPullRetry(key), {
      version: 0,
      attempts: 0,
      nextAttemptAt: 0,
      failureCode: null,
      holdClass: null,
    });
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state,snapshot_token,checkpoint_cursor) VALUES (${space},${env},9,'staging','original-token','original-cursor')`;
    const retry = {
      attempts: 3,
      nextAttemptAt: 12345,
      failureCode: "unavailable" as const,
      holdClass: null,
    };
    const first = yield* store.transact(
      store.writePullRetryTx({ ...key, expectedVersion: 0, retry }),
    );
    assert.deepStrictEqual(first, { ...retry, version: 1 });
    const retryBytes = new TextEncoder().encode(JSON.stringify({ ...retry, version: 1 })).length;
    const bytes = () =>
      sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='memory_input_bytes' AND scope_key=''`;
    assert.strictEqual((yield* bytes())[0]!.value, retryBytes);
    const fresh = yield* Effect.service(Store.MemoryStore).pipe(
      Effect.provide(Layer.fresh(Store.layer)),
    );
    assert.deepStrictEqual(yield* fresh.readPullRetry(key), first);
    assert.isNull(
      yield* fresh.transact(fresh.writePullRetryTx({ ...key, expectedVersion: 0, retry })),
    );
    const held = {
      attempts: 4,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      failureCode: "identity_mismatch" as const,
      holdClass: "identity" as const,
    };
    yield* fresh
      .transact(
        Effect.gen(function* () {
          yield* fresh.writePullRetryTx({ ...key, expectedVersion: 1, retry: held });
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.exit);
    assert.deepStrictEqual(yield* fresh.readPullRetry(key), first);
    assert.strictEqual((yield* bytes())[0]!.value, retryBytes);
    yield* fresh.transact(fresh.writePullRetryTx({ ...key, expectedVersion: 1, retry: held }));
    assert.strictEqual((yield* fresh.readPullRetry(key)).nextAttemptAt, Number.MAX_SAFE_INTEGER);
    const cursor = yield* sql<{
      after_sequence: number;
      snapshot_token: string;
      checkpoint_cursor: string;
    }>`SELECT after_sequence,snapshot_token,checkpoint_cursor FROM memory_sync_cursors WHERE space=${space} AND hub_environment_id=${env}`;
    assert.deepStrictEqual(cursor[0], {
      after_sequence: 9,
      snapshot_token: "original-token",
      checkpoint_cursor: "original-cursor",
    });
    yield* fresh.transact(
      fresh.writePullRetryTx({
        ...key,
        expectedVersion: 2,
        retry: { attempts: 0, nextAttemptAt: 0, failureCode: null, holdClass: null },
      }),
    );
    assert.strictEqual((yield* fresh.readPullRetry(key)).version, 3);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("resolution failure reports and permanent holds are owner fenced and targeted", () =>
  Effect.gen(function* () {
    const { store, sql, ownership, ticket, key, submission } = yield* seedSubmission;
    const failure = {
      ownership,
      now: 1,
      failureCode: "generation_failed" as const,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      holdClass: "availability" as const,
      reportConflictFailure: true,
    };
    assert.isNull(
      yield* store.transact(
        store.failResolutionTicketTx({ ...failure, ownership: { ...ownership, version: 0 } }),
      ),
    );
    yield* store
      .transact(
        Effect.gen(function* () {
          yield* store.failResolutionTicketTx(failure);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.exit);
    assert.strictEqual((yield* store.pendingReports(100)).length, 0);
    const failed = yield* store.transact(store.failResolutionTicketTx(failure));
    assert.strictEqual(failed?.nextAttemptAt, Number.MAX_SAFE_INTEGER);
    assert.strictEqual((yield* store.pendingReports(100))[0]?.operationId, ticket.attemptId);
    assert.strictEqual(
      (yield* store.readWorkHold(`resolve:${space}:${ticket.attemptId}`))?.holdClass,
      "availability",
    );
    assert.isNull(yield* store.transact(store.failResolutionTicketTx(failure)));
    const fresh = yield* Effect.service(Store.MemoryStore).pipe(
      Effect.provide(Layer.fresh(Store.layer)),
    );
    assert.deepStrictEqual(
      (yield* fresh.transact(
        fresh.rearmResolutionHoldsTx({
          memorySpaceId: space,
          holdClass: "identity",
          now: 2,
          afterId: "",
          limit: 100,
        }),
      )).changedIds,
      [],
    );
    assert.deepStrictEqual(
      (yield* fresh.transact(
        fresh.rearmResolutionHoldsTx({
          memorySpaceId: space,
          holdClass: "availability",
          now: 2,
          afterId: "",
          limit: 100,
        }),
      )).changedIds,
      [`resolve:${space}:${ticket.attemptId}`],
    );
    const recovered = (yield* fresh.readRecoverableResolutionTickets({
      memorySpaceId: space,
      now: 2,
      limit: 100,
    }))[0]!;
    const owner = yield* fresh.transact(
      fresh.acquireResolutionTicketTx({
        key,
        expectedVersion: recovered.version,
        owner: "fresh",
        coordinatorEpoch: 2,
        now: 2,
        ownedUntil: 100,
      }),
    );
    if (!owner) throw new Error("fixture");
    const newOwnership = { ...key, owner: "fresh", coordinatorEpoch: 2, version: owner.version };
    // Discover before submission: once uncertainty exists no new candidate may start.
    yield* fresh.recoverClaimCandidates(0);
    const candidate = (yield* fresh.readDueClaimCandidates(1, 0, space))[0]!;
    const submitted = yield* fresh.transact(
      fresh.persistResolutionSubmissionTx({
        ownership: newOwnership,
        submission,
        digest: memoryOperationDigest(submission.operation),
      }),
    );
    const submitOwner = { ...newOwnership, version: submitted.version };
    assert.strictEqual(
      (yield* fresh
        .transact(fresh.failResolutionTicketTx({ ...failure, ownership: submitOwner, now: 3 }))
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    const held = yield* fresh.transact(
      fresh.failResolutionTicketTx({
        ...failure,
        ownership: submitOwner,
        now: 3,
        reportConflictFailure: false,
      }),
    );
    assert.deepStrictEqual(held?.submission, submission);
    assert.strictEqual((yield* fresh.pendingReports(100)).length, 1);
    // Claim-stage hold also needs its generation, frozen attempt and live coordinator ownership.
    yield* sql`UPDATE memory_outbox SET status='running',claimed_by='2',claimed_until=100,frozen_claim_json=${JSON.stringify(M.MemoryHubClaimInput.make({ protocolVersion: 1, memorySpaceId: ticket.memorySpaceId, memoryId: ticket.memoryId, conflictId: ticket.conflictId, conflictHeadSet: ticket.conflictHeadSet, holderEnvironmentId: ticket.holderEnvironmentId, attemptId: ticket.attemptId, frozenDefaultModelSelection: ticket.frozenDefaultModelSelection }))} WHERE id=${candidate.id}`;
    const hold = {
      memorySpaceId: space,
      candidateId: candidate.id,
      expectedGeneration: 0,
      expectedAttempt: candidate.attempt,
      attemptId: ticket.attemptId,
      coordinatorEpoch: 2,
      now: 4,
      failureCode: "unavailable" as const,
      holdClass: "authorization" as const,
    };
    assert.isFalse(
      yield* fresh.transact(fresh.holdClaimCandidateTx({ ...hold, coordinatorEpoch: 1 })),
    );
    assert.isTrue(yield* fresh.transact(fresh.holdClaimCandidateTx(hold)));
    assert.deepStrictEqual(yield* fresh.readDueClaimCandidates(100, 5, space), []);
    assert.deepStrictEqual(
      (yield* fresh.transact(
        fresh.rearmResolutionHoldsTx({
          memorySpaceId: space,
          holdClass: "authorization",
          now: 5,
          afterId: "",
          limit: 100,
        }),
      )).changedIds,
      [candidate.id],
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("renewed ticket expiry persists only for the same owned lease and CAS version", () =>
  Effect.gen(function* () {
    const { store, ticket, key, ownership } = yield* seedSubmission;
    const renewedLease = { ...ticket, expiresAtHubTime: "1970-01-01T00:02:00.000Z" };
    const input = {
      ownership,
      now: 1,
      expectedExpiresAtHubTime: ticket.expiresAtHubTime,
      renewedLease,
    };
    assert.strictEqual(
      (yield* store
        .transact(
          store.renewResolutionTicketTx({
            ...input,
            renewedLease: { ...renewedLease, fencingToken: ticket.fencingToken + 1 },
          }),
        )
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.strictEqual(
      (yield* store
        .transact(
          store.renewResolutionTicketTx({
            ...input,
            renewedLease: {
              ...renewedLease,
              frozenDefaultModelSelection: {
                ...ticket.frozenDefaultModelSelection,
                model: "other",
              },
            },
          }),
        )
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    yield* store
      .transact(
        Effect.gen(function* () {
          yield* store.renewResolutionTicketTx(input);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.exit);
    const next = yield* store.transact(store.renewResolutionTicketTx(input));
    assert.strictEqual(next?.ticket.expiresAtHubTime, renewedLease.expiresAtHubTime);
    assert.isNull(yield* store.transact(store.renewResolutionTicketTx(input)));
    const fresh = yield* Effect.service(Store.MemoryStore).pipe(
      Effect.provide(Layer.fresh(Store.layer)),
    );
    const recovery = (yield* fresh.readRecoverableResolutionTickets({
      memorySpaceId: space,
      now: 101,
      limit: 100,
    }))[0]!;
    assert.strictEqual(recovery.ticket.expiresAtHubTime, renewedLease.expiresAtHubTime);
    assert.strictEqual(recovery.ticket.attemptDeadlineHubTime, ticket.attemptDeadlineHubTime);
    assert.strictEqual(recovery.ticket.fencingToken, ticket.fencingToken);
    assert.isNull(
      yield* fresh.transact(
        fresh.renewResolutionTicketTx({
          ...input,
          ownership: { ...ownership, version: next!.version },
          now: 101,
        }),
      ),
    );
    assert.strictEqual(key.attemptId, recovery.ticket.attemptId);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "retires only a correlated definitive rejection while preserving uncertain and accepted submissions",
  () =>
    Effect.gen(function* () {
      const { store, sql, ticket, ownership, key, submission } = yield* seedSubmission;
      yield* store.recoverClaimCandidates(0);
      const candidate = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
      const frozen = M.MemoryHubClaimInput.make({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        holderEnvironmentId: env,
        conflictId: ticket.conflictId,
        conflictHeadSet: ticket.conflictHeadSet,
        attemptId: ticket.attemptId,
        frozenDefaultModelSelection: ticket.frozenDefaultModelSelection,
      });
      yield* sql`UPDATE memory_outbox SET frozen_claim_json=${JSON.stringify(frozen)} WHERE id=${candidate.id}`;
      assert.strictEqual(
        (yield* store.findClaimCandidate({ memorySpaceId: space, attemptId: ticket.attemptId }))
          ?.id,
        candidate.id,
      );
      const submitted = yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership,
          submission,
          digest: memoryOperationDigest(submission.operation),
        }),
      );
      const owner = { ...ownership, version: submitted.version };
      const rejection: M.MemoryHubReceipt = {
        operationId: submission.operation.operationId,
        memoryId: memory,
        operationDigest: memoryOperationDigest(submission.operation),
        outcome: "rejected",
        hubSequence: null,
        failureCode: "fenced",
      };
      const input = {
        ownership: owner,
        candidateId: candidate.id,
        expectedGeneration: 0,
        rejection,
        now: 1,
        nextAttemptAt: 2,
      };
      assert.strictEqual(
        (yield* store
          .transact(
            store.retireRejectedSubmissionTx({
              ...input,
              rejection: { ...rejection, operationId: M.MemoryOperationId.make(id(30000)) },
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.retireRejectedSubmissionTx({
              ...input,
              rejection: { ...rejection, operationDigest: "b".repeat(64) },
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      assert.isNull(
        yield* store.transact(
          store.retireRejectedSubmissionTx({ ...input, expectedGeneration: 1 }),
        ),
      );
      const uncertain = yield* sql<{
        ticket_json: string;
        frozen_claim_json: string;
      }>`SELECT ticket_json,(SELECT frozen_claim_json FROM memory_outbox WHERE id=${candidate.id}) AS frozen_claim_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.isNotNull(JSON.parse(uncertain[0]!.ticket_json).submission);
      assert.isNotNull(uncertain[0]!.frozen_claim_json);
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* store.retireRejectedSubmissionTx(input);
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit);
      const next = yield* store.transact(store.retireRejectedSubmissionTx(input));
      assert.strictEqual(next?.state, "terminal");
      assert.strictEqual(next?.approval?.outcome, "rejected");
      assert.isNull(next?.submission);
      assert.isNull(yield* store.transact(store.retireRejectedSubmissionTx(input)));
      const retired = yield* sql<{
        frozen_claim_json: string | null;
        sync_version: number;
      }>`SELECT frozen_claim_json,sync_version FROM memory_outbox WHERE id=${candidate.id}`;
      assert.isNull(retired[0]!.frozen_claim_json);
      assert.strictEqual(retired[0]!.sync_version, 1);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${`submission:${ticket.attemptId}`}`)
          .length,
        0,
      );
      // A separate attempt already carrying an accepted approval must never retire.
      const approvedTicket = { ...ticket, attemptId: M.MemoryOperationId.make(id(30100)) };
      yield* store.persistResolutionTicket(approvedTicket);
      const approvedKey = { ...key, attemptId: approvedTicket.attemptId };
      const approvedOwner = yield* store.transact(
        store.acquireResolutionTicketTx({
          key: approvedKey,
          expectedVersion: 0,
          owner: "accepted",
          coordinatorEpoch: 1,
          now: 0,
          ownedUntil: 100,
        }),
      );
      if (!approvedOwner) throw new Error("fixture");
      const acceptedSubmission = yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership: {
            ...approvedKey,
            owner: "accepted",
            coordinatorEpoch: 1,
            version: approvedOwner.version,
          },
          submission: { ...submission, attemptId: approvedTicket.attemptId },
          digest: memoryOperationDigest(submission.operation),
        }),
      );
      const approval: M.MemoryHubReceipt = {
        operationId: rejection.operationId,
        memoryId: memory,
        operationDigest: rejection.operationDigest,
        outcome: "accepted",
        hubSequence: 1,
      };
      const approved = yield* store.transact(
        store.transitionResolutionTicketTx({
          ownership: {
            ...approvedKey,
            owner: "accepted",
            coordinatorEpoch: 1,
            version: acceptedSubmission.version,
          },
          nextState: "approved",
          now: 1,
          ownedUntil: 100,
          nextAttemptAt: 1,
          approval,
        }),
      );
      assert.strictEqual(
        (yield* store
          .transact(
            store.retireRejectedSubmissionTx({
              ...input,
              ownership: {
                ...approvedKey,
                owner: "accepted",
                coordinatorEpoch: 1,
                version: approved!.version,
              },
            }),
          )
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("late final checkpoint page cannot replace a newer bootstrap join", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const input = { memorySpaceId: space, hubEnvironmentId: env };
    yield* store.transact(
      store.advanceBootstrapTx({
        ...input,
        expectedState: "unbound",
        nextState: "staging",
        checkpointId: "old",
        snapshotToken: "synthetic-old",
        checkpointSequence: 1,
        nextCursor: null,
      }),
    );
    assert.isTrue(
      yield* store.transact(
        store.discardBootstrapTx({
          ...input,
          expectedSnapshotToken: "synthetic-old",
          expectedCheckpointId: "old",
          expectedCheckpointSequence: 1,
        }),
      ),
    );
    yield* store.transact(
      store.advanceBootstrapTx({
        ...input,
        expectedState: "unbound",
        nextState: "staging",
        checkpointId: "new",
        snapshotToken: "synthetic-new",
        checkpointSequence: 2,
        nextCursor: null,
      }),
    );
    const before = yield* store.readBootstrap(input);
    yield* store
      .transact(
        Effect.gen(function* () {
          yield* store.installCheckpointPage({
            memorySpaceId: space,
            hubEnvironmentId: env,
            expectedSnapshotToken: "synthetic-old",
            expectedCheckpointSequence: 1,
            checkpointId: "old",
            page: checkpoint(),
          });
          yield* store.completeCheckpoint({
            ...input,
            checkpointId: "old",
            expectedSnapshotToken: "synthetic-old",
            expectedCheckpointSequence: 1,
            pageCount: 1,
          });
        }),
      )
      .pipe(Effect.result);
    assert.deepStrictEqual(yield* store.readBootstrap(input), before);
    assert.isUndefined((yield* store.loadAggregate(space, memory)).item);
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='old'`).length,
      0,
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE checkpoint_stage_id='old'`).length,
      0,
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_compaction_state WHERE space=${space} AND published=1`)
        .length,
      0,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("checkpoint ports reject mismatched stage identity before creating bodies", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* beginFixtureCheckpoint;
    const before = yield* store.readBootstrap(fixtureCheckpointIdentity);
    for (const identity of [
      { ...fixtureCheckpointIdentity, hubEnvironmentId: M.EnvironmentId.make("other") },
      { ...fixtureCheckpointIdentity, expectedSnapshotToken: "synthetic-other" },
      { ...fixtureCheckpointIdentity, checkpointId: "other" },
      { ...fixtureCheckpointIdentity, expectedCheckpointSequence: 2 },
      { ...fixtureCheckpointIdentity, memorySpaceId: M.MemorySpaceId.make(id(90)) },
    ]) {
      assert.strictEqual(
        (yield* store.installCheckpointPage({ ...identity, page: checkpoint() }).pipe(Effect.flip))
          ._tag,
        "MemoryStoreConflict",
      );
      assert.strictEqual(
        (yield* store.completeCheckpoint({ ...identity, pageCount: 1 }).pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
    }
    assert.deepStrictEqual(yield* store.readBootstrap(fixtureCheckpointIdentity), before);
    assert.strictEqual((yield* sql`SELECT 1 FROM memory_payloads`).length, 0);
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE record_kind='checkpoint'`).length,
      0,
    );
    yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() });
    assert.deepStrictEqual(yield* sql`SELECT checkpoint_stage_id FROM memory_payloads`, [
      { checkpoint_stage_id: "fixture" },
    ]);
    yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() });
    assert.strictEqual((yield* store.readBootstrap(fixtureCheckpointIdentity)).pageCount, 1);
    yield* store.completeCheckpoint({ ...fixtureCheckpointIdentity, pageCount: 1 });
    const completed = yield* store.readBootstrap(fixtureCheckpointIdentity);
    assert.strictEqual(completed.state, "ready");
    assert.isNull(completed.snapshotToken);
    assert.strictEqual(completed.afterSequence, 1);
    assert.deepStrictEqual(yield* sql`SELECT checkpoint_stage_id FROM memory_payloads`, [
      { checkpoint_stage_id: null },
    ]);
    assert.strictEqual(
      (yield* store
        .completeCheckpoint({ ...fixtureCheckpointIdentity, pageCount: 1 })
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.strictEqual(
      (yield* store
        .installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() })
        .pipe(Effect.flip))._tag,
      "MemoryStoreConflict",
    );
    assert.deepStrictEqual(yield* store.readBootstrap(fixtureCheckpointIdentity), completed);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("checkpoint completion CAS failure rolls back final page and canonical publication", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* beginFixtureCheckpoint;
    const before = yield* store.readBootstrap(fixtureCheckpointIdentity);
    // Suppress only the final conditional transition after canonical writes ran.
    yield* sql`CREATE TRIGGER reject_checkpoint_completion BEFORE UPDATE OF bootstrap_state ON memory_sync_cursors WHEN NEW.bootstrap_state='ready' BEGIN SELECT RAISE(IGNORE); END`;
    const failure = yield* store
      .transact(
        Effect.gen(function* () {
          yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() });
          yield* store.completeCheckpoint({ ...fixtureCheckpointIdentity, pageCount: 1 });
        }),
      )
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryStoreConflict");
    assert.deepStrictEqual(yield* store.readBootstrap(fixtureCheckpointIdentity), before);
    for (const table of [
      "memory_payloads",
      "memory_inbox_pending",
      "memory_identity_ledger",
      "memory_revisions",
      "memory_items",
      "memory_compaction_state",
    ]) {
      assert.strictEqual((yield* sql.unsafe(`SELECT 1 FROM ${table}`)).length, 0);
    }
    yield* sql`DROP TRIGGER reject_checkpoint_completion`;
    yield* store.transact(
      Effect.gen(function* () {
        yield* store.installCheckpointPage({ ...fixtureCheckpointIdentity, page: checkpoint() });
        yield* store.completeCheckpoint({ ...fixtureCheckpointIdentity, pageCount: 1 });
      }),
    );
    assert.strictEqual((yield* store.readBootstrap(fixtureCheckpointIdentity)).state, "ready");
    assert.isDefined((yield* store.loadAggregate(space, memory)).item);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("recovery closes a frozen cycle despite continuous frontier and orphan tails", () =>
  Effect.gen(function* () {
    const { store } = yield* seedResolutionConflict;
    const sql = yield* SqlClient.SqlClient;
    const item = (yield* store.loadAggregate(space, memory)).item;
    if (item?.status !== "quarantined") throw new Error("fixture");
    const appendItems = Effect.fnUntraced(function* (start: number, count: number) {
      for (let n = start; n < start + count; n++) {
        const other = M.MemoryId.make(id(2000 + n));
        const copy = { ...item, memoryId: other, conflict: { ...item.conflict, memoryId: other } };
        yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) SELECT space,${other},scope_json,scope_key,heads_json,status,projection_watermark,${JSON.stringify(copy)},availability_json FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
      }
    });
    // Seed a real claim through recovery before copying its metadata for the orphan.
    yield* store.recoverClaimCandidates(0);
    yield* appendItems(0, 205);
    yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at) SELECT 'early-orphan',space,${id(1900)},kind,'pending',metadata_json,0 FROM memory_outbox WHERE space=${space} AND memory_id=${memory} AND kind='claim' LIMIT 1`;
    assert.strictEqual((yield* sql`SELECT 1 FROM memory_outbox WHERE id='early-orphan'`).length, 1);
    for (let n = 0; n < 205; n++) yield* store.enqueueWork(backgroundWork(`tail:${n}`));
    yield* store.recoverClaimCandidates(0);
    yield* sql`DELETE FROM memory_outbox WHERE space=${space} AND memory_id=${memory} AND kind='claim'`;
    yield* sql`UPDATE memory_outbox SET status='pending',terminal_at=NULL WHERE id='early-orphan'`;
    for (let round = 1; round <= 8; round++) {
      yield* appendItems(205 + (round - 1) * 100, 100);
      for (let n = 0; n < 100; n++) yield* store.enqueueWork(backgroundWork(`tail:${round}:${n}`));
      yield* store.recoverClaimCandidates(round);
    }
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_outbox WHERE space=${space} AND memory_id=${memory} AND kind='claim' AND status='pending'`)
        .length,
      1,
    );
    assert.strictEqual(
      (yield* sql<{ status: string }>`SELECT status FROM memory_outbox WHERE id='early-orphan'`)[0]!
        .status,
      "cancelled",
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("new checkpoint judgment bodies receive stage ownership at insertion", () =>
  Effect.gen(function* () {
    const { store, sql, submission } = yield* seedSubmission;
    if (submission.operation.kind !== "resolve") throw new Error("fixture");
    const op = submission.operation;
    yield* beginFixtureCheckpoint;
    yield* store.installCheckpointPage({
      ...fixtureCheckpointIdentity,
      page: {
        ...checkpoint(),
        revisions: [],
        resolutions: [{ resolution: op.resolution, payload: op.resolutionPayload }],
      },
    });
    assert.deepStrictEqual(
      yield* sql`SELECT checkpoint_stage_id FROM memory_payloads WHERE space=${space} AND payload_ref=${op.resolution.judgmentRef}`,
      [{ checkpoint_stage_id: "fixture" }],
    );
    assert.isTrue(
      yield* store.transact(
        store.discardBootstrapTx({
          ...fixtureCheckpointIdentity,
          expectedCheckpointId: fixtureCheckpointIdentity.checkpointId,
        }),
      ),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${op.resolution.judgmentRef}`)
        .length,
      0,
    );
    assert.isAbove((yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space}`).length, 0);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("review-r11 stale claim hold can overwrite a reacquired owner in same epoch", () =>
  Effect.gen(function* () {
    const { store, claim } = yield* seedResolutionConflict;
    yield* store.recoverClaimCandidates(0);
    const c = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
    yield* store.transact(
      store.prepareClaimAttemptTx({
        memorySpaceId: space,
        candidateId: c.id,
        expectedGeneration: 0,
        conflictHeads: claim.conflictHeadSet,
        proposedClaim: claim,
      }),
    );
    assert.isTrue(yield* store.claimCandidate(c.id, 2, 0));
    const stale = {
      memorySpaceId: space,
      candidateId: c.id,
      expectedGeneration: 0,
      expectedAttempt: c.attempt + 1,
      attemptId: claim.attemptId,
      coordinatorEpoch: 2,
      now: 1,
      failureCode: "unavailable" as const,
      holdClass: "availability" as const,
    };
    assert.isTrue(yield* store.transact(store.holdClaimCandidateTx(stale)));
    yield* store.transact(
      store.rearmResolutionHoldsTx({
        memorySpaceId: space,
        holdClass: "availability",
        now: 2,
        afterId: "",
        limit: 100,
      }),
    );
    assert.isTrue(yield* store.claimCandidate(c.id, 2, 2));
    const overwritten = yield* store.transact(store.holdClaimCandidateTx({ ...stale, now: 3 }));
    assert.isFalse(overwritten);
    assert.isTrue(
      yield* store.transact(
        store.holdClaimCandidateTx({ ...stale, now: 3, expectedAttempt: c.attempt + 2 }),
      ),
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("review-r11 failure report ignores durable delivered guard after report compaction", () =>
  Effect.gen(function* () {
    const { store, sql, key, ownership } = yield* seedSubmission;
    const first = yield* store.transact(
      store.failResolutionTicketTx({
        ownership,
        now: 1,
        failureCode: "generation_failed",
        nextAttemptAt: 2,
        reportConflictFailure: true,
      }),
    );
    if (!first) throw new Error("fixture");
    const report = (yield* store.pendingReports(100))[0]!;
    yield* store.acknowledgeReport({
      ...report,
      state: "delivered",
      reportThread: { environmentId: env, threadId: M.ThreadId.make(id(500)) },
      sequence: 1,
    });
    // Model the existing retention cleanup: report row removed, persistent guard retained.
    yield* sql`DELETE FROM memory_report_outbox WHERE report_id=${report.reportId}`;
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_import_keys WHERE space=${space} AND key_kind='report_delivered' AND key=${report.reportId}`)
        .length,
      1,
    );
    const owner = yield* store.transact(
      store.acquireResolutionTicketTx({
        key,
        expectedVersion: first.version,
        owner: "again",
        coordinatorEpoch: 2,
        now: 2,
        ownedUntil: 100,
      }),
    );
    if (!owner) throw new Error("fixture");
    yield* store.transact(
      store.failResolutionTicketTx({
        ownership: { ...key, version: owner.version, owner: "again", coordinatorEpoch: 2 },
        now: 3,
        failureCode: "generation_failed",
        nextAttemptAt: 4,
        reportConflictFailure: true,
      }),
    );
    assert.deepStrictEqual(yield* store.pendingReports(100), []);
    assert.isFalse(yield* store.claimReport(report.reportId, "delivery", 4, 100));
    assert.deepStrictEqual(yield* store.pendingReports(100), []);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("review-r11 held resolution sweep cannot advance past 100 live owners", () =>
  Effect.gen(function* () {
    const { store, sql, ticket } = yield* seedSubmission;
    const source = (yield* sql<{
      ticket_json: string;
      metadata_json: string;
    }>`SELECT ticket_json,metadata_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`)[0]!;
    for (let n = 1000; n < 1100; n++) {
      const t = JSON.parse(source.ticket_json);
      t.ticket.attemptId = id(n);
      t.nextAttemptAt = Number.MAX_SAFE_INTEGER;
      t.ownedUntil = 1000;
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,ticket_json,sync_version,next_attempt_at,hold_class) VALUES (${`resolve:${space}:${id(n)}`},${space},${memory},'resolve','pending',${source.metadata_json},${JSON.stringify(t)},${t.version},${Number.MAX_SAFE_INTEGER},'availability')`;
    }
    const t = JSON.parse(source.ticket_json);
    t.ticket.attemptId = id(2000);
    t.nextAttemptAt = Number.MAX_SAFE_INTEGER;
    t.ownedUntil = null;
    t.owner = null;
    const target = `resolve:${space}:${id(2000)}`;
    yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,ticket_json,sync_version,next_attempt_at,hold_class) VALUES (${target},${space},${memory},'resolve','pending',${source.metadata_json},${JSON.stringify(t)},${t.version},${Number.MAX_SAFE_INTEGER},'availability')`;
    let afterId = "";
    let seenTarget = false;
    let sawSkipPage = false;
    for (let n = 0; n < 10; n++) {
      const page = yield* store.transact(
        store.rearmResolutionHoldsTx({
          memorySpaceId: space,
          holdClass: "availability",
          now: 2,
          afterId,
          limit: 100,
        }),
      );
      // Baseline returned changed IDs only. Keep the same fixture executable when only
      // product files are reverted: an empty skip page cannot advance to the target.
      if (Array.isArray(page)) {
        if (page.includes(target)) seenTarget = true;
        afterId = page.at(-1) ?? afterId;
        continue;
      }
      assert.isAtMost(page.inspected, 100);
      if (page.inspected === 100 && page.changedIds.length === 0) sawSkipPage = true;
      if (page.changedIds.includes(target)) seenTarget = true;
      if (!page.more) break;
      assert.isNotNull(page.next);
      assert.isTrue(page.next! > afterId);
      afterId = page.next!;
    }
    assert.isTrue(seenTarget);
    assert.isTrue(sawSkipPage);
    assert.isNull((yield* store.readWorkHold(target))?.holdClass);
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT id,space,kind,status,next_attempt_at,hold_class FROM memory_outbox WHERE id>'' ORDER BY id LIMIT 100`;
    yield* Effect.log("R13_REARM_PLAN", plan).pipe(
      Effect.provide(Logger.layer([Logger.consolePretty({ colors: false })])),
    );
    assert.isTrue(
      plan.every((r) => !r.detail.includes("SCAN") && !r.detail.includes("TEMP B-TREE")),
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("private retry charges its own input meter without invalidating producer staging", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const triggers = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_sync_cursors'`;

    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${env},0,'ready')`;
    yield* sql`INSERT INTO memory_hub_retention(space,handles_json,reserved_snapshot_id,snapshot_generation,published_pinned_bytes) VALUES (${space},'[]','review-stage',7,2)`;
    yield* sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,metadata_json,reason,checkpoint_id,missing_parents_json) VALUES (${space},'review-page','checkpoint','{}','hub_snapshot','hub:review-stage','[]')`;
    const before =
      yield* sql`SELECT reserved_snapshot_id,snapshot_generation FROM memory_hub_retention WHERE space=${space}`;
    yield* store.transact(
      store.writePullRetryTx({
        memorySpaceId: space,
        hubEnvironmentId: env,
        expectedVersion: 0,
        retry: { attempts: 1, nextAttemptAt: 10, failureCode: "unavailable", holdClass: null },
      }),
    );
    const after =
      yield* sql`SELECT reserved_snapshot_id,snapshot_generation FROM memory_hub_retention WHERE space=${space}`;

    assert.strictEqual(after[0]!.reserved_snapshot_id, "review-stage");
    assert.deepStrictEqual(after, before);
    assert.strictEqual(triggers.length, 6);
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:review-stage'`)
        .length,
      1,
    );
    const charged = (yield* sql<{
      value: number;
    }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='memory_input_bytes' AND scope_key=''`)[0]!
      .value;
    const generation =
      yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation' AND scope_key=''`;
    yield* store.transact(
      store.writePullRetryTx({
        memorySpaceId: space,
        hubEnvironmentId: env,
        expectedVersion: 1,
        retry: { attempts: 2, nextAttemptAt: 20, failureCode: "unavailable", holdClass: null },
      }),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT reserved_snapshot_id,snapshot_generation FROM memory_hub_retention WHERE space=${space}`,
      before,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation' AND scope_key=''`,
      generation,
    );
    assert.strictEqual(
      (yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='memory_input_bytes' AND scope_key=''`)[0]!
        .value,
      charged,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("sync hold rearm advances across unrelated history within the inspected budget", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* store.apply(decision(operation()));
    const source = (yield* sql<{
      id: string;
      metadata_json: string;
    }>`SELECT id,metadata_json FROM memory_outbox WHERE kind='sync' LIMIT 1`)[0]!;
    yield* sql`UPDATE memory_outbox SET status='retry',next_attempt_at=${Number.MAX_SAFE_INTEGER},hold_class='availability' WHERE id=${source.id}`;
    for (let n = 0; n < 210; n++) {
      yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at) VALUES (${`a:${String(n).padStart(4, "0")}`},'other','sync','completed',${source.metadata_json},0)`;
    }
    const input = {
      memorySpaceId: space,
      holdClass: "availability" as const,
      now: 2,
      afterId: "",
      limit: 100,
    };
    const first = yield* store.transact(store.rearmSyncHoldsTx(input));
    assert.deepStrictEqual(first, { changedIds: [], inspected: 100, next: "a:0099", more: true });
    // More trailing history does not change first-page reads or bytes/continuation.
    for (let n = 0; n < 100; n++) {
      yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at) VALUES (${`z:${n}`},'other','sync','completed',${source.metadata_json},0)`;
    }
    assert.deepStrictEqual(yield* store.transact(store.rearmSyncHoldsTx(input)), first);
    let next = first.next!;
    let changed = false;
    for (let n = 0; n < 5; n++) {
      const page = yield* store.transact(store.rearmSyncHoldsTx({ ...input, afterId: next }));
      assert.isAtMost(page.inspected, 100);
      if (page.changedIds.includes(source.id)) changed = true;
      if (!page.more) break;
      assert.isTrue(page.next! > next);
      next = page.next!;
    }
    assert.isTrue(changed);
    assert.isNull((yield* store.readWorkHold(source.id))?.holdClass);
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT id,space,kind,status,next_attempt_at,hold_class FROM memory_outbox WHERE id>'' ORDER BY id LIMIT 100`;
    yield* Effect.log("R13_SYNC_REARM_PLAN", plan).pipe(
      Effect.provide(Logger.layer([Logger.consolePretty({ colors: false })])),
    );
    assert.isTrue(
      plan.every((r) => !r.detail.includes("SCAN") && !r.detail.includes("TEMP B-TREE")),
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("held uncertain submission rearms without loading its body", () =>
  Effect.gen(function* () {
    const { store, sql, submission, ownership } = yield* seedSubmission;
    const submitted = yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(submission.operation),
      }),
    );
    const held = yield* store.transact(
      store.failResolutionTicketTx({
        ownership: { ...ownership, version: submitted.version },
        now: 1,
        failureCode: "unavailable",
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        holdClass: "availability",
        reportConflictFailure: false,
      }),
    );
    const before = (yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ownership.attemptId}`}`)[0]!;
    let bodyReads = 0;
    const observed = new Proxy(sql, {
      apply(target, _this, args) {
        if (String(args[0]).includes("memory_payloads")) bodyReads++;
        return Reflect.apply(target, target, args);
      },
    });
    const fresh = yield* Effect.service(Store.MemoryStore).pipe(
      Effect.provide(Layer.fresh(Store.layer)),
      Effect.provideService(SqlClient.SqlClient, observed),
    );
    const page = yield* fresh.transact(
      fresh.rearmResolutionHoldsTx({
        memorySpaceId: space,
        holdClass: "availability",
        now: 2,
        afterId: "",
        limit: 100,
      }),
    );
    assert.deepStrictEqual(page.changedIds, [`resolve:${space}:${ownership.attemptId}`]);
    assert.strictEqual(bodyReads, 0);
    const after = (yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ownership.attemptId}`}`)[0]!;
    assert.deepStrictEqual(
      JSON.parse(after.ticket_json).submission,
      JSON.parse(before.ticket_json).submission,
    );
    assert.strictEqual(JSON.parse(after.ticket_json).submissionDigest, held!.submissionDigest);
    assert.deepStrictEqual(
      (yield* store.readRecoverableResolutionTickets({
        memorySpaceId: space,
        now: 2,
        limit: 100,
      }))[0]!.submission,
      submission,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each([
  ["uncertain", "frontier"],
  ["approved", "frontier"],
  ["uncertain", "exposure"],
  ["approved", "exposure"],
  ["uncertain", "orphan"],
  ["approved", "orphan"],
] as const)("r14 recovery preserves %s submission through %s", ([state, path]) =>
  Effect.gen(function* () {
    const { store, sql, ticket, ownership, submission } = yield* seedSubmission;
    // Freeze a real discovered candidate before saving the submission.
    yield* store.recoverClaimCandidates(0);
    const candidate = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
    const claim: M.MemoryHubClaimInput = {
      protocolVersion: 1,
      memorySpaceId: space,
      memoryId: memory,
      holderEnvironmentId: env,
      conflictId: ticket.conflictId,
      conflictHeadSet: ticket.conflictHeadSet,
      attemptId: ticket.attemptId,
      frozenDefaultModelSelection: ticket.frozenDefaultModelSelection,
    };
    yield* store.transact(
      store.prepareClaimAttemptTx({
        memorySpaceId: space,
        candidateId: candidate.id,
        expectedGeneration: 0,
        conflictHeads: ticket.conflictHeadSet,
        proposedClaim: claim,
      }),
    );
    let saved = yield* store.transact(
      store.persistResolutionSubmissionTx({
        ownership,
        submission,
        digest: memoryOperationDigest(submission.operation),
      }),
    );
    if (state === "approved") {
      const op = submission.operation;
      if (op.kind !== "resolve") throw new Error("fixture");
      saved = (yield* store.transact(
        store.transitionResolutionTicketTx({
          ownership: { ...ownership, version: saved.version },
          now: 1,
          nextState: "approved",
          ownedUntil: 100,
          nextAttemptAt: 0,
          approval: {
            operationId: op.operationId,
            operationDigest: saved.submissionDigest!,
            memoryId: memory,
            outcome: "accepted",
            hubSequence: 7,
            resolutionApproval: {
              resolutionId: op.resolution.resolutionId,
              appliedAtUtc: op.resolution.appliedAtUtc,
              revertDeadlineUtc: op.resolution.revertDeadlineUtc,
            },
          },
        }),
      ))!;
    }
    if (path === "orphan")
      yield* sql`DELETE FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
    else if (path === "exposure")
      yield* sql`UPDATE memory_items SET item_json=json_set(item_json,'$.localAvailability.reasons',json('["secret_detected"]')) WHERE space=${space} AND memory_id=${memory}`;
    else {
      const next = operation(6);
      if (next.kind !== "upsert") throw new Error("fixture");
      const op = {
        ...next,
        expectedHeads: [M.MemoryRevisionId.make(id(13))],
        revision: { ...next.revision, parents: [M.MemoryRevisionId.make(id(13))] },
      };
      yield* store.apply(
        decideMemoryOperation(yield* store.loadAggregate(space, memory), op, Store.hubAdmission, {
          kind: "allowed",
        }),
      );
    }
    yield* store
      .transact(store.recoverClaimCandidates(101).pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.flip);
    const workId = `resolve:${space}:${ticket.attemptId}`;
    const before = (yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE id=${workId}`)[0]!;
    assert.deepStrictEqual(JSON.parse(before.ticket_json).submission, {
      ...submission,
      operation: JSON.parse(before.ticket_json).submission.operation,
    });
    assert.isUndefined(JSON.parse(before.ticket_json).reconcileRequired);
    yield* store.recoverClaimCandidates(101);
    const durable = (yield* sql<{
      ticket_json: string;
    }>`SELECT ticket_json FROM memory_outbox WHERE id=${workId}`)[0]!;
    assert.isNotNull(
      JSON.parse(durable.ticket_json).submission,
      "recovery must retain uncertain/accepted submission metadata and body",
    );
    const recovered = (yield* store.readRecoverableResolutionTickets({
      memorySpaceId: space,
      now: 101,
      limit: 10,
    }))[0]!;
    assert.deepStrictEqual(recovered.submission, submission);
    assert.strictEqual(recovered.submissionDigest, saved.submissionDigest);
    assert.deepStrictEqual(recovered.approval, saved.approval);
    assert.isTrue(recovered.reconcileRequired);
    assert.notStrictEqual(recovered.state, "terminal");
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${`submission:${ticket.attemptId}`}`)
        .length,
      1,
    );
    assert.deepStrictEqual(yield* store.readDueClaimCandidates(10, 101, space), []);
    // The CAS and prepare paths enforce the barrier too, even if a caller retained an old candidate.
    yield* sql`UPDATE memory_outbox SET status='pending',next_attempt_at=0 WHERE id=${candidate.id}`;
    assert.isFalse(yield* store.claimCandidate(candidate.id, 2, 101));
    const generation = (yield* sql<{
      sync_version: number;
    }>`SELECT sync_version FROM memory_outbox WHERE id=${candidate.id}`)[0]!.sync_version;
    assert.isNull(
      yield* store.transact(
        store.prepareClaimAttemptTx({
          memorySpaceId: space,
          candidateId: candidate.id,
          expectedGeneration: generation,
          conflictHeads: ticket.conflictHeadSet,
          proposedClaim: { ...claim, attemptId: M.MemoryOperationId.make(id(70001)) },
        }),
      ),
    );
    // Repeated recovery neither regenerates a claim nor grows/fences the same result again.
    yield* store.recoverClaimCandidates(102);
    assert.strictEqual(
      (yield* store.readRecoverableResolutionTickets({
        memorySpaceId: space,
        now: 102,
        limit: 10,
      }))[0]!.version,
      recovered.version,
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_outbox WHERE space=${space} AND memory_id=${memory} AND kind='claim'`)
        .length,
      1,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["uncertain", "rejected"] as const)(
  "r14 changed frontier reconciles %s without guessing absence",
  (outcome) =>
    Effect.gen(function* () {
      const { store, sql, key, ticket, ownership, submission } = yield* seedSubmission;
      const saved = yield* store.transact(
        store.persistResolutionSubmissionTx({
          ownership,
          submission,
          digest: memoryOperationDigest(submission.operation),
        }),
      );
      const next = operation(6);
      if (next.kind !== "upsert") throw new Error("fixture");
      const other = {
        ...next,
        expectedHeads: [M.MemoryRevisionId.make(id(13))],
        revision: { ...next.revision, parents: [M.MemoryRevisionId.make(id(13))] },
      };
      yield* store.apply(
        decideMemoryOperation(
          yield* store.loadAggregate(space, memory),
          other,
          Store.hubAdmission,
          { kind: "allowed" },
        ),
      );
      yield* store.recoverClaimCandidates(101);
      const durable = (yield* sql<{
        ticket_json: string;
      }>`SELECT ticket_json FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`)[0]!;
      assert.isNotNull(
        JSON.parse(durable.ticket_json).submission,
        "recovery must retain uncertain/accepted submission metadata and body",
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND payload_ref=${`submission:${ticket.attemptId}`}`)
          .length,
        1,
      );
      const recovered = (yield* store.readRecoverableResolutionTickets({
        memorySpaceId: space,
        now: 101,
        limit: 10,
      }))[0]!;
      assert.deepStrictEqual(recovered.submission, submission);
      const owner = (yield* store.transact(
        store.acquireResolutionTicketTx({
          key,
          expectedVersion: recovered.version,
          owner: "reconcile",
          coordinatorEpoch: 2,
          now: 101,
          ownedUntil: 200,
        }),
      ))!;
      const owned = { ...key, owner: "reconcile", coordinatorEpoch: 2, version: owner.version };
      const rejection: M.MemoryHubReceipt = {
        operationId: submission.operation.operationId,
        memoryId: memory,
        operationDigest: saved.submissionDigest!,
        outcome: "rejected",
        hubSequence: null,
        failureCode: "fenced",
      };
      assert.strictEqual(
        (yield* store.transact(
          store.reconcileResolutionSubmissionTx({ ownership: owned, now: 101 }),
        ))?.outcome,
        "uncertain",
      );
      assert.strictEqual(
        yield* store.transact(
          store.reconcileResolutionSubmissionTx({
            ownership: { ...owned, version: owned.version - 1 },
            now: 101,
          }),
        ),
        null,
      );
      const result = yield* store.transact(
        store.reconcileResolutionSubmissionTx({
          ownership: owned,
          now: 101,
          ...(outcome === "rejected" ? { rejection } : {}),
        }),
      );
      assert.strictEqual(result?.outcome, outcome === "rejected" ? "retired" : "uncertain");
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${`submission:${ticket.attemptId}`}`)
          .length,
        outcome === "rejected" ? 0 : 1,
      );
      yield* store.recoverClaimCandidates(102);
      assert.strictEqual(
        (yield* store.readDueClaimCandidates(10, 102, space)).length,
        outcome === "rejected" ? 1 : 0,
      );
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM memory_outbox r WHERE r.space=${space} AND r.memory_id=${memory} AND r.kind='resolve' AND r.status IN ('pending','retry','running') AND json_extract(r.ticket_json,'$.submission') IS NOT NULL LIMIT 1`;
      assert.isTrue(plan.some((r) => r.detail.includes("memory_outbox_active_resolution")));
      assert.isFalse(
        plan.some((r) => r.detail.includes("SCAN") || r.detail.includes("TEMP B-TREE")),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "r14 keyed canonical lookup sees checkpoint approval behind a local pending receipt",
  () =>
    Effect.gen(function* () {
      const { store, sql, ownership, submission } = yield* seedSubmission;
      const op = submission.operation;
      if (op.kind !== "resolve") throw new Error("fixture");
      const digest = memoryOperationDigest(op);
      const saved = yield* store.transact(
        store.persistResolutionSubmissionTx({ ownership, submission, digest }),
      );
      const args = { ownership: { ...ownership, version: saved.version }, now: 1 };
      for (const rejection of [
        {
          operationId: M.MemoryOperationId.make(id(79999)),
          memoryId: memory,
          operationDigest: digest,
          outcome: "rejected" as const,
          hubSequence: null,
          failureCode: "fenced" as const,
        },
        {
          operationId: op.operationId,
          memoryId: memory,
          operationDigest: "b".repeat(64),
          outcome: "rejected" as const,
          hubSequence: null,
          failureCode: "fenced" as const,
        },
      ])
        assert.strictEqual(
          (yield* store
            .transact(store.reconcileResolutionSubmissionTx({ ...args, rejection }))
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
      const receipt: M.MemoryHubReceipt = {
        operationId: op.operationId,
        memoryId: memory,
        operationDigest: digest,
        outcome: "accepted",
        hubSequence: 7,
        resolutionApproval: {
          resolutionId: op.resolution.resolutionId,
          appliedAtUtc: op.resolution.appliedAtUtc,
          revertDeadlineUtc: op.resolution.revertDeadlineUtc,
        },
      };
      // Snapshot representations may coexist with a local pending event. Three PK probes,
      // rather than the first local receipt, decide admission without reading the operation body.
      const local: M.MemoryMutationReceipt = {
        operationId: op.operationId,
        memoryId: memory,
        outcome: "accepted",
        revisionId: op.revision.revisionId,
        pendingSync: true,
      };
      yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES(1,${space},${memory},${op.operationId},'resolve',${env},${digest},'{}',${JSON.stringify(local)},0)`;
      yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES(${space},'hubReceipt',${op.operationId},${memory},${JSON.stringify({ receipt })})`;
      const result = yield* store.transact(store.reconcileResolutionSubmissionTx(args));
      assert.strictEqual(result?.outcome, "admitted");
      if (result?.outcome !== "admitted") throw new Error("fixture");
      assert.deepStrictEqual(result.receipt, receipt);
      assert.deepStrictEqual(result.row.submission, submission);
      assert.strictEqual(result.row.state, "approved");
    }).pipe(checkUsage, Effect.provide(live)),
);

const seedHeldResolutionAttempt = Effect.gen(function* () {
  const fixture = yield* seedSubmission;
  const { store, ticket } = fixture;
  yield* store.recoverClaimCandidates(0);
  const candidate = (yield* store.readDueClaimCandidates(1, 0, space))[0]!;
  const prepared = yield* store.transact(
    store.prepareClaimAttemptTx({
      memorySpaceId: space,
      candidateId: candidate.id,
      expectedGeneration:
        candidate.metadata.kind === "claim" ? (candidate.metadata.generation ?? 0) : 0,
      conflictHeads: ticket.conflictHeadSet,
      proposedClaim: {
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: memory,
        holderEnvironmentId: env,
        conflictId: ticket.conflictId,
        conflictHeadSet: ticket.conflictHeadSet,
        attemptId: ticket.attemptId,
        frozenDefaultModelSelection: ticket.frozenDefaultModelSelection,
      },
    }),
  );
  assert.isNotNull(prepared);
  assert.isTrue(yield* store.claimCandidate(candidate.id, 1, 0));
  const input = {
    ownership: fixture.ownership,
    candidateId: candidate.id,
    expectedGeneration:
      candidate.metadata.kind === "claim" ? (candidate.metadata.generation ?? 0) : 0,
    expectedAttempt: candidate.attempt + 1,
    now: 1,
    failureCode: "identity_mismatch" as const,
    holdClass: "identity" as const,
  };
  return { ...fixture, candidate, prepared: prepared!, input };
});

it.effect.each([
  { status: "running", holdClass: "identity" },
  { status: "retry", holdClass: "identity" },
  { status: "running", holdClass: "authorization" },
  { status: "retry", holdClass: "authorization" },
] as const)(
  "r15 atomically holds ticket and %s candidate through restart and paged rearm",
  ({ status, holdClass }) =>
    Effect.gen(function* () {
      const {
        store,
        sql,
        candidate,
        input: originalInput,
        key,
        ticket,
        prepared,
      } = yield* seedHeldResolutionAttempt;
      const input = { ...originalInput, holdClass };
      if (status === "retry")
        yield* store.retryClaimCandidate(candidate.id, 30_000, "identity_mismatch");
      const before =
        yield* sql`SELECT id,status,sync_version,attempt,next_attempt_at,claimed_by,claimed_until,frozen_claim_json,ticket_json,hold_class,failure_code FROM memory_outbox WHERE id IN (${candidate.id},${`resolve:${space}:${ticket.attemptId}`}) ORDER BY id`;
      // An injected failure in the second row's SQL must roll the first row back.
      yield* sql`CREATE TEMP TRIGGER r15_ticket_failure BEFORE UPDATE OF hold_class ON memory_outbox WHEN NEW.kind='resolve' BEGIN SELECT RAISE(ABORT,'synthetic ticket hold failure'); END`;
      const failure = yield* store.transact(store.holdResolutionAttemptTx(input)).pipe(Effect.exit);
      assert.strictEqual(failure._tag, "Failure");
      assert.deepStrictEqual(
        yield* sql`SELECT id,status,sync_version,attempt,next_attempt_at,claimed_by,claimed_until,frozen_claim_json,ticket_json,hold_class,failure_code FROM memory_outbox WHERE id IN (${candidate.id},${`resolve:${space}:${ticket.attemptId}`}) ORDER BY id`,
        before,
      );
      yield* sql`DROP TRIGGER r15_ticket_failure`;
      const held = yield* store.transact(store.holdResolutionAttemptTx(input));
      assert.strictEqual(held?.state, "recoverable");
      assert.strictEqual(held?.nextAttemptAt, Number.MAX_SAFE_INTEGER);
      assert.isNull(held?.owner);
      assert.isNull(yield* store.transact(store.holdResolutionAttemptTx(input)));
      const fresh = yield* Effect.service(Store.MemoryStore).pipe(
        Effect.provide(Layer.fresh(Store.layer)),
      );
      yield* fresh.recoverClaimCandidates(2);
      const ids = [candidate.id, `resolve:${space}:${ticket.attemptId}`];
      for (const target of ids) {
        assert.deepStrictEqual(yield* fresh.readWorkHold(target), {
          holdClass,
          failureCode: "identity_mismatch",
        });
        assert.strictEqual((yield* fresh.readWork(target))?.nextAttemptAt, Number.MAX_SAFE_INTEGER);
      }
      assert.deepStrictEqual(yield* fresh.readDueClaimCandidates(100, 2, space), []);
      assert.deepStrictEqual(
        yield* fresh.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 2,
          limit: 100,
        }),
        [],
      );
      assert.isFalse(yield* fresh.claimCandidate(candidate.id, 2, 2));
      assert.deepStrictEqual(yield* fresh.pendingReports(100), []);
      const heldRows = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
      const wrong = yield* fresh.transact(
        fresh.rearmResolutionHoldsTx({
          memorySpaceId: space,
          holdClass: holdClass === "identity" ? "authorization" : "identity",
          now: 3,
          afterId: "",
          limit: 100,
        }),
      );
      assert.deepStrictEqual(wrong.changedIds, []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, heldRows);
      for (const target of ids)
        assert.strictEqual((yield* fresh.readWorkHold(target))?.holdClass, holdClass);
      // One-row pages deliberately split the two holds. Follow visited keysets to completion.
      let afterId = "";
      const changed: string[] = [];
      for (let n = 0; n < 20; n++) {
        const page = yield* fresh.transact(
          fresh.rearmResolutionHoldsTx({
            memorySpaceId: space,
            holdClass,
            now: 4,
            afterId,
            limit: 1,
          }),
        );
        changed.push(...page.changedIds);
        if (!page.more) break;
        assert.isNotNull(page.next);
        assert.isTrue(page.next! > afterId);
        afterId = page.next!;
      }
      assert.deepStrictEqual(changed.sort(), ids.sort());
      for (const target of ids)
        assert.deepStrictEqual(yield* fresh.readWorkHold(target), {
          holdClass: null,
          failureCode: null,
        });
      const due = (yield* fresh.readDueClaimCandidates(100, 4, space))[0]!;
      assert.strictEqual(
        due.metadata.kind === "claim" ? (due.metadata.generation ?? 0) : 0,
        input.expectedGeneration,
      );
      assert.strictEqual(due.attempt, input.expectedAttempt);
      assert.isTrue(yield* fresh.claimCandidate(candidate.id, 2, 4));
      yield* TestClock.adjust(4);
      assert.deepStrictEqual(
        yield* fresh.transact(
          fresh.prepareClaimAttemptTx({
            memorySpaceId: space,
            candidateId: candidate.id,
            expectedGeneration: input.expectedGeneration,
            conflictHeads: ticket.conflictHeadSet,
          }),
        ),
        prepared,
      );
      const recovered = (yield* fresh.readRecoverableResolutionTickets({
        memorySpaceId: space,
        now: 4,
        limit: 100,
      }))[0]!;
      assert.deepStrictEqual(recovered.ticket, ticket);
      assert.isNotNull(
        yield* fresh.transact(
          fresh.acquireResolutionTicketTx({
            key,
            expectedVersion: recovered.version,
            owner: "restart",
            coordinatorEpoch: 2,
            now: 4,
            ownedUntil: 100,
          }),
        ),
      );
      assert.deepStrictEqual(yield* fresh.pendingReports(100), []);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("r15 stale ticket and candidate fences leave both rows unchanged", () =>
  Effect.gen(function* () {
    const { store, sql, input, ticket, candidate } = yield* seedHeldResolutionAttempt;
    const before = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
    for (const stale of [
      { ...input, ownership: { ...input.ownership, version: 0 } },
      { ...input, ownership: { ...input.ownership, coordinatorEpoch: 2 } },
      { ...input, ownership: { ...input.ownership, owner: "stale" } },
      { ...input, ownership: { ...input.ownership, memorySpaceId: M.MemorySpaceId.make(id(900)) } },
      { ...input, now: 100 },
      { ...input, candidateId: "unrelated" },
      { ...input, expectedGeneration: input.expectedGeneration + 1 },
      { ...input, expectedAttempt: input.expectedAttempt + 1 },
    ]) {
      assert.isNull(yield* store.transact(store.holdResolutionAttemptTx(stale)));
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, before);
    }
    // Same epoch reacquisition still increments the acquisition counter.
    for (const row of [
      { status: "running", owner: "2", until: 100 },
      { status: "running", owner: "1", until: 1 },
      { status: "retry", owner: "1", until: null },
      { status: "pending", owner: null, until: null },
      { status: "completed", owner: null, until: null },
    ]) {
      yield* sql`UPDATE memory_outbox SET status=${row.status},claimed_by=${row.owner},claimed_until=${row.until} WHERE id=${candidate.id}`;
      const fenced = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
      assert.isNull(yield* store.transact(store.holdResolutionAttemptTx(input)));
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, fenced);
    }
    yield* store.retryClaimCandidate(candidate.id, 1, "unavailable");
    assert.isTrue(yield* store.claimCandidate(candidate.id, 1, 1));
    const reacquired = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
    assert.isNull(yield* store.transact(store.holdResolutionAttemptTx(input)));
    assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, reacquired);
    yield* sql`UPDATE memory_outbox SET frozen_claim_json=json_set(frozen_claim_json,'$.attemptId',${id(901)}) WHERE id=${candidate.id}`;
    const differentAttempt = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
    assert.isNull(
      yield* store.transact(
        store.holdResolutionAttemptTx({ ...input, expectedAttempt: input.expectedAttempt + 1 }),
      ),
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, differentAttempt);
    assert.strictEqual(
      (yield* sql<{
        sync_version: number;
      }>`SELECT sync_version FROM memory_outbox WHERE id=${`resolve:${space}:${ticket.attemptId}`}`)[0]!
        .sync_version,
      input.ownership.version,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["submitting", "approved", "approval-only"] as const)(
  "r15 permanent refusal preserves %s without holds or failure reports",
  (state) =>
    Effect.gen(function* () {
      const { store, sql, input, submission } = yield* seedHeldResolutionAttempt;
      let version = input.ownership.version;
      if (state !== "approval-only") {
        const saved = yield* store.transact(
          store.persistResolutionSubmissionTx({
            ownership: input.ownership,
            submission,
            digest: memoryOperationDigest(submission.operation),
          }),
        );
        version = saved.version;
      }
      if (state !== "submitting") {
        const op = submission.operation;
        if (op.kind !== "resolve") throw new Error("fixture");
        const approved = yield* store.transact(
          store.transitionResolutionTicketTx({
            ownership: { ...input.ownership, version },
            now: 1,
            nextState: "approved",
            ownedUntil: 100,
            nextAttemptAt: 0,
            approval: {
              operationId: op.operationId,
              operationDigest: memoryOperationDigest(op),
              memoryId: memory,
              outcome: "accepted",
              hubSequence: 7,
              resolutionApproval: {
                resolutionId: op.resolution.resolutionId,
                appliedAtUtc: op.resolution.appliedAtUtc,
                revertDeadlineUtc: op.resolution.revertDeadlineUtc,
              },
            },
          }),
        );
        assert.isNotNull(approved);
        version = approved!.version;
      }
      const before = yield* sql`SELECT * FROM memory_outbox ORDER BY id`;
      const bodies = yield* sql`SELECT * FROM memory_payloads ORDER BY payload_ref`;
      assert.isNull(
        yield* store.transact(
          store.holdResolutionAttemptTx({
            ...input,
            ownership: { ...input.ownership, version },
          }),
        ),
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox ORDER BY id`, before);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_payloads ORDER BY payload_ref`,
        bodies,
      );
      assert.deepStrictEqual(yield* store.pendingReports(100), []);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("r16 nullable processing reads the actual local item counters and PK plans", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const key = `_local:${env}`;
    // Internal local keys are not MemorySpaceId UUIDs; seed nonempty item state to detect
    // an implementation that replaces nullable processing with an empty status constant.
    const deferred = '[{"state":"held","sinceAtUtc":"2026-10-14T00:00:00.000Z"}]';
    yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json,deferred_json,cleanup_pending) VALUES (${key},${memory},'{}','user','[]','quarantined',0,'{}','{"reasons":["secret_detected","scanner_pending","missing_parent"]}',${deferred},1)`;
    yield* sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,missing_parents_json,reason,metadata_json) VALUES (${key},'parked','operation','[]','missing_parent','{}')`;
    const input = { environmentId: env, memorySpaceId: null, hubEnvironmentId: null };
    const status = yield* store.readLocalProcessingStatus(input);
    assert.strictEqual(status.quarantined, 1);
    assert.strictEqual(status.parked, 1);
    assert.strictEqual(status.processing.deferred, 1);
    assert.strictEqual(status.processing.oldestDeferredAtUtc, "2026-10-14T00:00:00.000Z");
    assert.strictEqual(status.processing.scannerHeldItems, 1);
    assert.strictEqual(status.processing.scannerPendingItems, 1);
    assert.strictEqual(status.processing.missingParentItems, 1);
    assert.strictEqual(status.processing.pendingCleanupItems, 1);
    assert.deepStrictEqual(
      yield* store.readLocalProcessingStatus({ ...input, hubEnvironmentId: env }),
      status,
    );
    yield* store
      .transact(
        sql`DELETE FROM memory_items WHERE space=${key}`.pipe(
          Effect.andThen(Effect.fail("rollback")),
        ),
      )
      .pipe(Effect.flip);
    assert.deepStrictEqual(yield* store.readLocalProcessingStatus(input), status);
    const plans = [
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT dimension,value FROM memory_quota_counters WHERE space=${key} AND scope_key='' AND dimension IN ('processing_quarantined','processing_eligible','processing_indexed','processing_cleanup','processing_scanner_held','processing_scanner_pending','processing_missing_parent','processing_deferred','processing_pending_sync','processing_parked','processing_report_backlog','processing_report_failed','processing_admission_failures')`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT processing_oldest_at FROM memory_items WHERE space=${key} AND processing_oldest_at IS NOT NULL ORDER BY processing_oldest_at LIMIT 1`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT projection_watermark FROM memory_compaction_state WHERE space=${key}`,
      yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT bootstrap_state,after_sequence FROM memory_sync_cursors WHERE space=${space} AND hub_environment_id=${env}`,
    ];
    for (const plan of plans) {
      assert.isTrue(plan.every((row) => row.detail.includes("SEARCH")));
      assert.isFalse(plan.some((row) => /SCAN|TEMP B-TREE/.test(row.detail)));
    }
    yield* Effect.log("R16_PROCESSING_EXPLAIN", JSON.stringify(plans)).pipe(
      Effect.provide(Logger.layer([Logger.consolePretty({ colors: false })])),
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("recovery skips completed installCredential admin before work decoding", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const requestId = M.MemoryOperationId.make(id(17000));
    const first: Store.AdminRecord = {
      requestId,
      requestDigest: hash,
      expectedVersion: 0,
      stage: "prepared",
      action: {
        requestId,
        expectedVersion: 0,
        action: "installCredential",
        hubEnvironmentId: env,
        endpoint: "http://127.0.0.1:43123",
        memorySpaceId: space,
      },
      secretName: "synthetic-installed-member",
      result: null,
      memberVersion: null,
    };
    const result = {
      view: {
        provenance: null,
        settings: {
          mode: "member" as const,
          hubEnvironmentId: env,
          endpoint: "http://127.0.0.1:43123",
          memorySpaceId: space,
          secretName: "synthetic-installed-member",
        },
        version: 1,
      },
    };
    yield* store.transact(store.writeHubAdminTx({ record: first, expectedStage: null }));
    for (const [stage, expectedStage] of [
      ["activated", "prepared"],
      ["ready", "activated"],
      ["acknowledged", "ready"],
    ] as const)
      yield* store.transact(
        store.writeHubAdminTx({
          record: { ...first, stage, result: stage === "activated" ? null : result },
          expectedStage,
        }),
      );
    const adminBefore = yield* sql`SELECT * FROM memory_outbox WHERE kind='admin'`;

    assert.strictEqual(adminBefore.length, 1);
    // A full page of unrelated work must still consume exactly one frozen page.
    for (let n = 0; n < 100; n++) yield* store.enqueueWork(backgroundWork(`unrelated:${n}`));
    const countersBefore =
      yield* sql`SELECT * FROM memory_quota_counters WHERE space!='_claim_recovery' ORDER BY space,dimension,scope_key`;
    const fresh = yield* Store.MemoryStore.pipe(Effect.provide(Store.layer));
    yield* fresh.recoverClaimCandidates(0);
    const cursor = yield* sql<{
      value: number;
    }>`SELECT value FROM memory_quota_counters WHERE space='_claim_recovery' AND dimension='orphan'`;
    assert.strictEqual(cursor[0]!.value, 100);
    yield* fresh.recoverClaimCandidates(1);
    yield* fresh.recoverClaimCandidates(2);
    assert.deepStrictEqual(yield* sql`SELECT * FROM memory_outbox WHERE kind='admin'`, adminBefore);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters WHERE space!='_claim_recovery' ORDER BY space,dimension,scope_key`,
      countersBefore,
    );
    assert.strictEqual(
      (yield* fresh.transact(fresh.readHubAdminTx(requestId)))?.stage,
      "acknowledged",
    );
    assert.isUndefined(yield* fresh.readWork(`admin:${requestId}`));
    assert.isUndefined(yield* fresh.readWorkOperation(`admin:${requestId}`));
    const ack = yield* fresh
      .acknowledgeOutbox(`admin:${requestId}`, {
        operationId: requestId,
        memoryId: memory,
        operationDigest: hash,
        outcome: "accepted",
        hubSequence: 1,
      })
      .pipe(Effect.flip);
    assert.strictEqual(ack._tag, "MemoryStoreConflict");
    const plans = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN WITH page AS MATERIALIZED (
      SELECT rowid FROM memory_outbox WHERE rowid>0 AND rowid<=101 ORDER BY rowid LIMIT 100
    ) SELECT page.rowid,o.id,NOT EXISTS(SELECT 1 FROM memory_items i WHERE i.space=o.space AND i.memory_id=o.memory_id) AS gone
    FROM page LEFT JOIN memory_outbox o ON o.rowid=page.rowid AND o.kind IN ('claim','resolve') ORDER BY page.rowid`;
    assert.isTrue(
      plans.some(
        (row) => row.detail.includes("INTEGER PRIMARY KEY") && row.detail.includes("rowid>"),
      ),
    );
    yield* Effect.logInfo("R17_ORPHAN_EXPLAIN", JSON.stringify(plans)).pipe(
      Effect.provide(Logger.layer([Logger.consolePretty({ colors: false })])),
      Effect.provideService(Console.Console, console),
      Effect.provideService(References.MinimumLogLevel, "Info"),
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "r18 discovers push-only protocol hold through a fresh store and clears after rearm",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* store.apply(decision(operation()));
      const c = (yield* store.readEligibleOutbox(space, 0, 10))[0]!;
      const ownership = yield* store.transact(
        store.acquireSyncWorkTx({
          workId: c.work.id,
          operationId: c.operationId,
          operationDigest: c.operationDigest,
          owner: "r18",
          expectedVersion: c.version,
          now: 0,
          ownedUntil: 100,
        }),
      );
      if (!ownership) throw new Error("fixture");
      assert.isTrue(
        yield* store.transact(
          store.retrySyncWorkTx({
            ownership,
            now: 1,
            nextAttemptAt: Number.MAX_SAFE_INTEGER,
            failureCode: "unsupported_protocol",
            holdClass: "protocol",
          }),
        ),
      );
      const fresh = yield* Effect.service(Store.MemoryStore).pipe(
        Effect.provide(Layer.fresh(Store.layer)),
      );
      const key = { memorySpaceId: space, hubEnvironmentId: env };
      assert.isNull((yield* fresh.readPullRetry(key)).holdClass);
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), ["protocol"]);
      assert.deepStrictEqual(
        yield* fresh.readPersistedHoldClasses({
          ...key,
          memorySpaceId: M.MemorySpaceId.make(id(88888)),
        }),
        [],
      );
      yield* fresh.transact(
        fresh.rearmSyncHoldsTx({
          memorySpaceId: space,
          holdClass: "protocol",
          now: 2,
          afterId: "",
          limit: 100,
        }),
      );
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), []);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["authorization", "protocol", "identity", "availability"] as const)(
  "r18 discovers pull-only %s hold for the exact hub and clears after reset",
  (holdClass) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const key = { memorySpaceId: space, hubEnvironmentId: env };
      assert.isNotNull(
        yield* store.transact(
          store.writePullRetryTx({
            ...key,
            expectedVersion: 0,
            retry: {
              attempts: 1,
              nextAttemptAt: Number.MAX_SAFE_INTEGER,
              failureCode: "unavailable",
              holdClass,
            },
          }),
        ),
      );
      const fresh = yield* Effect.service(Store.MemoryStore).pipe(
        Effect.provide(Layer.fresh(Store.layer)),
      );
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), [holdClass]);
      assert.deepStrictEqual(
        yield* fresh.readPersistedHoldClasses({
          ...key,
          hubEnvironmentId: M.EnvironmentId.make("other-hub"),
        }),
        [],
      );
      assert.deepStrictEqual(
        yield* fresh.readPersistedHoldClasses({
          ...key,
          memorySpaceId: M.MemorySpaceId.make(id(88888)),
        }),
        [],
      );
      yield* fresh.transact(
        fresh.writePullRetryTx({
          ...key,
          expectedVersion: 1,
          retry: { attempts: 0, nextAttemptAt: 0, failureCode: null, holdClass: null },
        }),
      );
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), []);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "r18 discovers resolution ticket and candidate holds independently without pull holds",
  () =>
    Effect.gen(function* () {
      const { store, sql, candidate, ticket, input } = yield* seedHeldResolutionAttempt;
      assert.isNotNull(yield* store.transact(store.holdResolutionAttemptTx(input)));
      const fresh = yield* Effect.service(Store.MemoryStore).pipe(
        Effect.provide(Layer.fresh(Store.layer)),
      );
      const key = { memorySpaceId: space, hubEnvironmentId: env };
      assert.isNull((yield* fresh.readPullRetry(key)).holdClass);
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), ["identity"]);
      // Retain only the ticket hold, then only the candidate hold.
      yield* sql`UPDATE memory_outbox SET hold_class=NULL WHERE id=${candidate.id}`;
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), ["identity"]);
      yield* sql`UPDATE memory_outbox SET hold_class=NULL WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), []);
      yield* sql`UPDATE memory_outbox SET hold_class='identity' WHERE id=${candidate.id}`;
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), ["identity"]);
      yield* fresh.transact(
        fresh.rearmResolutionHoldsTx({
          memorySpaceId: space,
          holdClass: "identity",
          now: 2,
          afterId: "",
          limit: 100,
        }),
      );
      assert.deepStrictEqual(yield* fresh.readPersistedHoldClasses(key), []);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "r18 bounds class discovery with indexed presence probes and excludes inactive or unclassified work",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const key = { memorySpaceId: space, hubEnvironmentId: env };
      // Irrelevant history and unclassified legacy MAX rows cannot turn absence into a scan.
      yield* sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
      INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at,hold_class)
      SELECT 'r18-history-'||i,${space},'sync','completed','{}',9007199254740991,'availability' FROM n`;
      yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at,hold_class)
      VALUES ('r18-legacy',${space},'sync','retry','{}',9007199254740991,NULL),
        ('r18-backoff',${space},'sync','retry','{}',10,'availability'),
        ('r18-summary',${space},'summary','retry','{}',9007199254740991,'availability'),
        ('r18-foreign',${id(88888)},'sync','retry','{}',9007199254740991,'availability')`;
      assert.deepStrictEqual(yield* store.readPersistedHoldClasses(key), []);
      yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at,hold_class)
      VALUES ('r18-revert',${space},'revert_intent','retry','{}',9007199254740991,'protocol'),
        ('r18-claim',${space},'claim','running','{}',9007199254740991,'identity'),
        ('r18-resolve',${space},'resolve','pending','{}',9007199254740991,'availability'),
        ('r18-sync',${space},'sync','retry','{}',9007199254740991,'authorization'),
        ('r18-duplicate',${space},'sync','retry','{}',9007199254740991,'protocol')`;
      assert.deepStrictEqual(yield* store.readPersistedHoldClasses(key), [
        "authorization",
        "protocol",
        "identity",
        "availability",
      ]);
      const plans = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT 1 FROM memory_outbox INDEXED BY memory_outbox_held_class
      WHERE space=${space} AND hold_class='protocol' AND hold_class IS NOT NULL AND next_attempt_at=9007199254740991
        AND kind IN ('sync','revert_intent','claim','resolve') AND status IN ('pending','retry','running') LIMIT 1`;
      const pullPlans = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT pull_retry_json FROM memory_sync_cursors WHERE space=${space} AND hub_environment_id=${env}`;
      for (const plan of [...plans, ...pullPlans]) {
        assert.include(plan.detail, "SEARCH");
        assert.notInclude(plan.detail, "SCAN");
        assert.notInclude(plan.detail, "TEMP B-TREE");
      }
      assert.isTrue(
        plans.some(
          (p) =>
            p.detail.includes("memory_outbox_held_class") &&
            p.detail.includes("space=? AND hold_class=?"),
        ),
      );
      yield* Effect.logInfo(
        "R18_DISCOVERY_EXPLAIN",
        JSON.stringify({ outbox: plans, pull: pullPlans }),
      ).pipe(
        Effect.provide(Logger.layer([Logger.consolePretty({ colors: false })])),
        Effect.provideService(Console.Console, console),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      );
      yield* sql`UPDATE memory_outbox SET hold_class=NULL WHERE id IN ('r18-revert','r18-claim','r18-resolve','r18-sync','r18-duplicate')`;
      assert.deepStrictEqual(yield* store.readPersistedHoldClasses(key), []);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("r18 discovery surfaces storage failure instead of reporting no holds", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    // This is the isolated fixture database, never an installed environment.
    yield* sql`DROP INDEX memory_outbox_held_class`;
    const failure = yield* store
      .readPersistedHoldClasses({ memorySpaceId: space, hubEnvironmentId: env })
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MemoryStorageError");
    assert.strictEqual(failure.stage, "persisted-hold-discovery");
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "enforces substring item/text equality and +1, refreshing bytes on payload_ref replacement",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const filter = { memorySpaceId: space, scope: { kind: "user" as const }, limit: 1 };
      const op = operation();
      if (op.kind === "forget") throw new Error("Fixture kind");
      yield* store.apply(decision(op));
      const body = (length: number) =>
        JSON.stringify({ ...op.payload, text: "synthetic" + "x".repeat(length - 9) });
      const sharedLength = 4194;
      const lastLength = M.MEMORY_SUBSTRING_MAX_UTF8_BYTES - 1999 * sharedLength;
      yield* sql`UPDATE memory_payloads SET body_json=${body(sharedLength)} WHERE space=${space}`;
      yield* sql`UPDATE memory_items SET search_text_bytes=${sharedLength} WHERE space=${space}`;
      yield* sql`WITH RECURSIVE ids(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM ids WHERE n<2001)
      INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation)
      SELECT space,printf('00000000-0000-4000-8000-%012d',n),scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,
      json_set(item_json,'$.memoryId',printf('00000000-0000-4000-8000-%012d',n),'$.revision.memoryId',printf('00000000-0000-4000-8000-%012d',n)),availability_json,generation FROM memory_items,ids WHERE space=${space} AND memory_id=${memory}`;
      const shortRef = id(9000);
      const longRef = id(9001);
      const longerRef = id(9002);
      for (const [ref, length] of [
        [shortRef, 10],
        [longRef, lastLength],
        [longerRef, lastLength + 1],
      ] as const)
        yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${ref},${id(2001)},${body(length)},'[]')`;
      yield* sql`UPDATE memory_items SET payload_ref=${longRef} WHERE space=${space} AND memory_id=${id(2001)}`;
      yield* store.searchCoverage(filter);
      yield* store.searchCoverage(filter);
      assert.deepStrictEqual(yield* store.searchCoverage(filter), {
        ready: true,
        eligible: 2000,
        indexed: 0,
        textBytes: M.MEMORY_SUBSTRING_MAX_UTF8_BYTES,
      });
      assert.strictEqual((yield* store.search(filter, "synthetic", "substring")).items.length, 1);
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json)
      SELECT space,${id(2002)},scope_json,scope_key,heads_json,status,${shortRef},projection_watermark,json_set(item_json,'$.memoryId',${id(2002)},'$.revision.memoryId',${id(2002)}),availability_json FROM memory_items WHERE space=${space} AND memory_id=${memory}`;
      // Reduce bytes so this refusal independently proves the item ceiling.
      yield* sql`UPDATE memory_items SET payload_ref=${shortRef} WHERE space=${space} AND memory_id=${id(2001)}`;
      assert.strictEqual((yield* store.searchCoverage(filter)).eligible, 2001);
      assert.isTrue(
        (yield* store.searchCoverage(filter)).textBytes < M.MEMORY_SUBSTRING_MAX_UTF8_BYTES,
      );
      assert.strictEqual(
        (yield* store.search(filter, "synthetic", "substring").pipe(Effect.flip))._tag,
        "MemoryCapacityError",
      );
      yield* sql`DELETE FROM memory_items WHERE space=${space} AND memory_id=${id(2002)}`;
      yield* sql`UPDATE memory_items SET payload_ref=${longerRef} WHERE space=${space} AND memory_id=${id(2001)}`;
      assert.strictEqual(
        (yield* store.searchCoverage(filter)).textBytes,
        M.MEMORY_SUBSTRING_MAX_UTF8_BYTES + 1,
      );
      assert.strictEqual(
        (yield* store.search(filter, "synthetic", "substring").pipe(Effect.flip))._tag,
        "MemoryCapacityError",
      );
      yield* sql`UPDATE memory_items SET payload_ref=${shortRef} WHERE space=${space} AND memory_id=${id(2001)}`;
      assert.strictEqual((yield* store.searchCoverage(filter)).textBytes, 1999 * sharedLength + 10);
      assert.strictEqual((yield* store.search(filter, "synthetic", "substring")).items.length, 1);
    }).pipe(checkUsage, Effect.provide(live)),
);
it.effect.each(["fts", "substring"] as const)(
  "%s continues across more than 100 matches at the item and byte ceilings",
  (mode) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const op = operation();
      if (op.kind === "forget") throw new Error("Fixture kind");
      yield* store.apply(decision(op));
      const aggregate = yield* store.loadAggregate(space, memory);
      yield* store.index({
        memorySpaceId: space,
        memoryId: memory,
        revisionId: op.revision.revisionId,
        generation: aggregate.generation,
      });
      yield* sql`WITH RECURSIVE ids(n) AS (SELECT 3 UNION ALL SELECT n+1 FROM ids WHERE n<106)
        INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation,index_state,indexed_generation)
        SELECT space,printf('00000000-0000-4000-8000-%012d',n),scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,
        json_set(item_json,'$.memoryId',printf('00000000-0000-4000-8000-%012d',n),'$.revision.memoryId',printf('00000000-0000-4000-8000-%012d',n)),availability_json,generation,index_state,indexed_generation FROM memory_items,ids WHERE space=${space} AND memory_id=${memory}`;
      yield* sql`INSERT INTO memory_items_fts(rowid,body) SELECT rowid,'synthetic searchable text' FROM memory_items WHERE memory_id!=${memory}`;
      const filter = { memorySpaceId: space, scope: { kind: "user" as const }, limit: 100 };
      const first = yield* store.search(filter, "synthetic", mode);
      assert.isTrue(first.items.length > 0 && first.items.length <= 100);
      assert.isFalse(first.exhausted);
      assert.strictEqual(first.examinedAfterMemoryId, first.items.at(-1)!.memoryId);
      const next = yield* store.search(
        { ...filter, afterMemoryId: first.examinedAfterMemoryId! },
        "synthetic",
        mode,
      );
      assert.strictEqual(next.items.length, 105 - first.items.length);
      assert.isTrue(next.exhausted);
      assert.deepStrictEqual(
        [...first.items, ...next.items].map((i) => i.memoryId),
        Array.from({ length: 105 }, (_, n) => id(n + 2)),
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "r2 compacts dependency bodies but preserves forget identity until dependents are purged",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse(now));
      yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${hash},1,'active')`;
      const first = operation(8800);
      const successor = operation(8801);
      const derived = operation(8802);
      if (first.kind !== "upsert" || successor.kind !== "upsert" || derived.kind !== "upsert")
        throw new Error("fixture");
      const target = M.MemoryId.make(id(8803));
      const operations: M.MemoryOperation[] = [
        first,
        {
          ...successor,
          expectedHeads: [first.revision.revisionId],
          revision: { ...successor.revision, parents: [first.revision.revisionId] },
        },
        {
          ...derived,
          memoryId: target,
          revision: { ...derived.revision, memoryId: target },
          payload: { ...derived.payload, derivedFromMemoryRevisions: [first.revision.revisionId] },
        },
      ];
      for (const op of operations) {
        const ledger = yield* store.transact(
          store.appendHubEntryTx({
            operation: op,
            operationDigest: memoryOperationDigest(op),
            outcome: "accepted",
            now: Date.parse(now),
          }),
        );
        yield* store.apply({
          ...decideMemoryOperation(
            yield* store.loadAggregate(space, op.memoryId),
            op,
            Store.hubAdmission,
            { kind: "allowed" },
          ),
          receipt: ledger.entry.receipt,
        });
      }
      const at = Date.parse(now) + 2 * M.MEMORY_LOG_RETENTION_MS;
      yield* sql`UPDATE memory_payloads SET purge_eligible_after=0 WHERE payload_ref=${first.revision.payloadRef}`;
      const handle = yield* store.transact(
        store.prepareHubCheckpointTx({
          authority: { ...leaseAuthority, now: Effect.succeed(at) },
          checkpointId: "r2-lineage",
          snapshotToken: "r2-lineage",
          hubEnvironmentId: env,
        }),
      );
      yield* store.transact(
        store.publishCheckpointAndFloorTx({
          memorySpaceId: space,
          checkpointId: "r2-lineage",
          expectedFloor: 0,
          nextFloor: handle.checkpointSequence,
          now: at,
        }),
      );
      for (let i = 0; i < 3; i++)
        yield* store.transact(
          store.compactEligibleHistoryTx({
            memorySpaceId: space,
            expectedFloor: handle.checkpointSequence,
            now: at + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
            limit: 100,
          }),
        );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${first.revision.payloadRef}`)
          .length,
        0,
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_revisions WHERE revision_id=${first.revision.revisionId}`)
          .length,
        1,
      );
      const snapshotRows = yield* sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE checkpoint_id='hub:r2-lineage' ORDER BY page_ordinal`;
      const pages = yield* Effect.forEach(snapshotRows, (row) =>
        decodeCheckpointPage(row.metadata_json),
      );
      const dependency = pages
        .flatMap((page) => page.revisions)
        .find((pair) => pair.revision.revisionId === first.revision.revisionId);
      assert.isDefined(dependency);
      assert.isNull(dependency!.payload);
      const forgotten: M.MemoryOperation = {
        protocolVersion: 1,
        kind: "forget",
        memorySpaceId: space,
        memoryId: memory,
        operationId: M.MemoryOperationId.make(id(8810)),
        originEnvironmentId: env,
        expectedHeads: [successor.revision.revisionId],
        tombstone: {
          memorySpaceId: space,
          memoryId: memory,
          deleteOperationId: M.MemoryOperationId.make(id(8810)),
          deletingEnvironmentId: env,
          deletedAtUtc: M.MemoryUtcTimestamp.make(now),
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      };
      yield* store.apply(
        decideMemoryOperation(
          yield* store.loadAggregate(space, memory),
          forgotten,
          Store.hubAdmission,
          { kind: "allowed" },
        ),
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${target}`).length,
        0,
      );
      assert.strictEqual((yield* store.loadAggregate(space, target)).item?.status, "blocked");
      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: handle.checkpointSequence,
          now: at + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_revisions WHERE revision_id=${first.revision.revisionId}`)
          .length,
        0,
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("r3 thread lineage pins identity without retaining revision bodies", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(Date.parse(now));
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${env},${hash},1,'active')`;
    const first = operation(8800);
    const successor = operation(8801);
    const derived = operation(8802);
    if (first.kind !== "upsert" || successor.kind !== "upsert" || derived.kind !== "upsert")
      throw new Error("fixture");
    const thread = { environmentId: env, threadId: M.ThreadId.make("lineage-owner") };
    yield* sql`CREATE TABLE orchestration_events (application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
    yield* store.appendThreadLineage(thread, space, [first.revision.revisionId]);
    const target = M.MemoryId.make(id(8803));
    const operations: M.MemoryOperation[] = [
      first,
      {
        ...successor,
        expectedHeads: [first.revision.revisionId],
        revision: { ...successor.revision, parents: [first.revision.revisionId] },
      },
      {
        ...derived,
        memoryId: target,
        revision: { ...derived.revision, memoryId: target },
        payload: { ...derived.payload, derivedFromMemoryRevisions: [] },
      },
    ];
    for (const op of operations) {
      const ledger = yield* store.transact(
        store.appendHubEntryTx({
          operation: op,
          operationDigest: memoryOperationDigest(op),
          outcome: "accepted",
          now: Date.parse(now),
        }),
      );
      yield* store.apply({
        ...decideMemoryOperation(
          yield* store.loadAggregate(space, op.memoryId),
          op,
          Store.hubAdmission,
          { kind: "allowed" },
        ),
        receipt: ledger.entry.receipt,
      });
    }
    const at = Date.parse(now) + 2 * M.MEMORY_LOG_RETENTION_MS;
    yield* sql`UPDATE memory_payloads SET purge_eligible_after=0 WHERE payload_ref=${first.revision.payloadRef}`;
    const handle = yield* store.transact(
      store.prepareHubCheckpointTx({
        authority: { ...leaseAuthority, now: Effect.succeed(at) },
        checkpointId: "r2-lineage",
        snapshotToken: "r2-lineage",
        hubEnvironmentId: env,
      }),
    );
    yield* store.transact(
      store.publishCheckpointAndFloorTx({
        memorySpaceId: space,
        checkpointId: "r2-lineage",
        expectedFloor: 0,
        nextFloor: handle.checkpointSequence,
        now: at,
      }),
    );
    for (let i = 0; i < 3; i++)
      yield* store.transact(
        store.compactEligibleHistoryTx({
          memorySpaceId: space,
          expectedFloor: handle.checkpointSequence,
          now: at + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
          limit: 100,
        }),
      );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${first.revision.payloadRef}`)
        .length,
      0,
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_revisions WHERE revision_id=${first.revision.revisionId}`)
        .length,
      1,
    );
    // No payload referenced rA while compaction ran. Create a dependent afterwards,
    // proving that the surviving identity still supports forget's reverse closure.
    const next = operation(8820);
    if (next.kind !== "upsert") throw new Error("fixture");
    const nextDerived: M.MemoryOperation = {
      ...next,
      memoryId: target,
      expectedHeads: [derived.revision.revisionId],
      revision: { ...next.revision, memoryId: target, parents: [derived.revision.revisionId] },
      payload: { ...next.payload, derivedFromMemoryRevisions: [first.revision.revisionId] },
    };
    yield* store.apply(
      decideMemoryOperation(
        yield* store.loadAggregate(space, target),
        nextDerived,
        Store.hubAdmission,
        { kind: "allowed" },
      ),
    );
    const forgotten: M.MemoryOperation = {
      protocolVersion: 1,
      kind: "forget",
      memorySpaceId: space,
      memoryId: memory,
      operationId: M.MemoryOperationId.make(id(8810)),
      originEnvironmentId: env,
      expectedHeads: [successor.revision.revisionId],
      tombstone: {
        memorySpaceId: space,
        memoryId: memory,
        deleteOperationId: M.MemoryOperationId.make(id(8810)),
        deletingEnvironmentId: env,
        deletedAtUtc: M.MemoryUtcTimestamp.make(now),
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      },
    };
    yield* store.apply(
      decideMemoryOperation(
        yield* store.loadAggregate(space, memory),
        forgotten,
        Store.hubAdmission,
        { kind: "allowed" },
      ),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${target}`).length,
      0,
    );
    assert.strictEqual((yield* store.loadAggregate(space, target)).item?.status, "blocked");
    yield* store.deleteThreadLineage(thread);
    yield* store.transact(
      store.compactEligibleHistoryTx({
        memorySpaceId: space,
        expectedFloor: handle.checkpointSequence,
        now: at + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
        limit: 100,
      }),
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_revisions WHERE revision_id=${first.revision.revisionId}`)
        .length,
      0,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

const missingCheckpointCases = [
  "hub_snapshot_bytes",
  "hub_snapshot_rows",
  "both",
  "marker",
  "marker-and-bytes",
  "marker-and-rows",
].flatMap((missing) =>
  ["usage", "other-space-admission", "new-record"].map((path) => ({ missing, path })),
);
it.effect.each(missingCheckpointCases)(
  "rejects missing checkpoint totals $missing before $path and rolls back all writes",
  ({ missing, path }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* store.apply({ ...approved(), identity: checkpoint().identities[0]! });
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_quota_counters WHERE space='_checkpoint_dirty'`,
        [],
      );
      assert.strictEqual(
        (yield* sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='checkpoint_initialized' AND scope_key=''`)[0]
          ?.value,
        1,
      );
      yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND
        (dimension=${missing} OR (${missing}='both' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows'))
         OR (${missing} IN ('marker','marker-and-bytes','marker-and-rows') AND dimension='checkpoint_initialized')
         OR (${missing}='marker-and-bytes' AND dimension='hub_snapshot_bytes')
         OR (${missing}='marker-and-rows' AND dimension='hub_snapshot_rows'))`;
      // Snapshot every memory table, including row caches, counters, FTS and outbox.
      const inventory = Effect.gen(function* () {
        const tables = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name`;
        const rows = [];
        for (const table of tables)
          rows.push({
            table: table.name,
            rows: (yield* sql.unsafe(`SELECT * FROM "${table.name}"`)).toSorted((a, b) =>
              JSON.stringify(a).localeCompare(JSON.stringify(b)),
            ),
          });
        return rows;
      });
      const before = yield* inventory;
      const other = M.MemorySpaceId.make(id(900));
      const failed = yield* store
        .transact(
          Effect.gen(function* () {
            yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES ('_rollback_probe','probe','',1)`;
            if (path === "usage") return yield* store.readHubUsageTx(space);
            if (path === "other-space-admission")
              return yield* store.reserveHubCheckpointTx({
                memorySpaceId: other,
                checkpointDeltaBytes: 1,
                publishedPinnedDeltaBytes: 0,
              });
            const identity: M.MemoryIdentityRecord = {
              memorySpaceId: space,
              memoryId: M.MemoryId.make(id(901)),
              scope: { kind: "user" },
              creatingEnvironmentId: env,
              createOperationId: M.MemoryOperationId.make(id(902)),
              createdAtUtc: M.MemoryUtcTimestamp.make(now),
            };
            const fence: M.MemoryFenceRecord = {
              memorySpaceId: space,
              memoryId: identity.memoryId,
              highestFencingToken: 0,
              activeLease: null,
            };
            yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES (${space},${identity.memoryId},${JSON.stringify(identity)},${JSON.stringify(fence)},66560,0)`;
            const cache = yield* sql<{
              checkpoint_bytes: number;
              checkpoint_rows: number;
            }>`SELECT checkpoint_bytes,checkpoint_rows FROM memory_identity_ledger WHERE memory_id=${identity.memoryId}`;
            assert.deepStrictEqual(cache, [{ checkpoint_bytes: 0, checkpoint_rows: 0 }]);
          }),
        )
        .pipe(Effect.flip);
      assert.instanceOf(failed, Store.MemoryStorageError);
      assert.strictEqual(failed.stage, "checkpoint-accounting");
      assert.instanceOf(failed.cause, CheckpointAccountingError);
      assert.strictEqual((failed.cause as CheckpointAccountingError).stage, "missing-total");
      assert.deepStrictEqual(yield* inventory, before);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each([0, 2])(
  "rejects checkpoint marker value %s in an unrelated empty transaction and retains validation evidence",
  (value) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* store.apply({ ...approved(), identity: checkpoint().identities[0]! });
      yield* sql`UPDATE memory_quota_counters SET value=${value} WHERE space=${space} AND dimension='checkpoint_initialized' AND scope_key=''`;
      const pending =
        yield* sql`SELECT * FROM memory_quota_counters WHERE space='_checkpoint_lifecycle'`;
      assert.deepStrictEqual(pending, [
        { space: "_checkpoint_lifecycle", dimension: space, scope_key: "", value: 1 },
      ]);
      const failed = yield* store.transact(Effect.void).pipe(Effect.flip);
      assert.instanceOf(failed, Store.MemoryStorageError);
      assert.strictEqual(failed.stage, "checkpoint-accounting");
      assert.instanceOf(failed.cause, CheckpointAccountingError);
      assert.strictEqual((failed.cause as CheckpointAccountingError).stage, "missing-total");
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_quota_counters WHERE space='_checkpoint_lifecycle'`,
        pending,
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("rejects a lost checkpoint total in an unrelated empty transaction", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    yield* store.apply({ ...approved(), identity: checkpoint().identities[0]! });
    yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_rows' AND scope_key=''`;
    const failed = yield* store.transact(Effect.void).pipe(Effect.flip);
    assert.instanceOf(failed, Store.MemoryStorageError);
    assert.strictEqual(failed.stage, "checkpoint-accounting");
    assert.instanceOf(failed.cause, CheckpointAccountingError);
    assert.strictEqual((failed.cause as CheckpointAccountingError).stage, "missing-total");
    assert.deepStrictEqual(
      yield* sql`SELECT dimension FROM memory_quota_counters WHERE space='_checkpoint_lifecycle'`,
      [{ dimension: space }],
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "initializes a genuinely new checkpoint space and keeps its lifecycle after the last record",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      assert.strictEqual(
        (yield* store.transact(store.readHubUsageTx(space))).requiredCheckpointBoundBytes,
        4096,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_quota_counters WHERE space=${space} AND dimension='checkpoint_initialized'`,
        [],
      );
      yield* store.apply({ ...approved(), identity: checkpoint().identities[0]! });
      yield* store.transact(sql`DELETE FROM memory_identity_ledger WHERE space=${space}`);
      assert.deepStrictEqual(
        yield* sql`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows','checkpoint_initialized') ORDER BY dimension`,
        [
          { dimension: "checkpoint_initialized", value: 1 },
          { dimension: "hub_snapshot_bytes", value: 0 },
          { dimension: "hub_snapshot_rows", value: 0 },
        ],
      );
      assert.strictEqual(
        (yield* store.transact(store.readHubUsageTx(space))).requiredCheckpointBoundBytes,
        4096,
      );
      yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_bytes' AND scope_key=''`;
      const failed = yield* store.transact(store.readHubUsageTx(space)).pipe(Effect.flip);
      assert.instanceOf(failed, Store.MemoryStorageError);
      assert.instanceOf(failed.cause, CheckpointAccountingError);
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "A2 bounded history shares candidate budget, advances empty slots, and uses indexed SQL before decode",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(decision());
      const item = (yield* store.readAccess(space, memory)).item!;
      // Invalid codecs in the large tail prove that LIMIT precedes decoding.
      const ids = Array.from({ length: 2000 }, (_, n) => id(100000 + n));
      yield* sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at)
    SELECT ${space},value,${memory},value,'invalid','invalid','inference','invalid',NULL,0 FROM json_each(${JSON.stringify(ids)})`;
      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const first = yield* store
        .historyPage({ memorySpaceId: space, memoryId: memory, limit: 1 }, item, env)
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.lengthOf(first.page.revisions, 1);
      assert.isNotNull(first.page.nextCursor);
      assert.lengthOf(first.page.resolutions, 0);
      const keyQueries = queries.filter(([query]) => query.includes("AS key"));
      assert.lengthOf(keyQueries, 1);
      let read = 0;
      for (const [query, params] of keyQueries) {
        read += (yield* sql.unsafe(query, params)).length;
        assert.match(query, /LIMIT/);
        const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params);
        const details = plan.map((r) => r.detail).join("\n");
        assert.match(
          details,
          /SEARCH memory_revisions USING COVERING INDEX memory_revisions_memory_idx/,
        );
        assert.notMatch(details, /SCAN|TEMP B-TREE/);
      }
      assert.strictEqual(read, 1);
      yield* sql`DELETE FROM memory_revisions WHERE revision_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
      yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json)
    SELECT ${space},value,${memory},'[]','[]',value,'{}','{}',${env},1,value,0,0,'invalid' FROM json_each(${JSON.stringify(ids)})`;
      // Null slot candidates consume budget without decoding unrelated resolution JSON.
      queries.length = 0;
      const empty = yield* store
        .historyPage(
          { memorySpaceId: space, memoryId: memory, limit: 2, cursor: "h1:3:0" },
          item,
          env,
        )
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.isEmpty(empty.page.revertResults);
      assert.isNotNull(empty.page.nextCursor);
      const next = yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 2, cursor: empty.page.nextCursor! },
        item,
        env,
      );
      assert.notStrictEqual(next.page.nextCursor, empty.page.nextCursor);
      const selected = queries.find(([query]) => query.includes("AS key"))!;
      assert.lengthOf(yield* sql.unsafe(selected[0], selected[1]), 2);
      yield* sql`DELETE FROM memory_resolutions WHERE resolution_json='invalid'`;
      for (const [category, table] of [
        [0, "memory_revisions"],
        [1, "memory_resolutions"],
        [2, "memory_report_outbox"],
        [3, "memory_resolutions"],
        [4, "memory_tombstones"],
      ] as const) {
        queries.length = 0;
        yield* store
          .historyPage(
            { memorySpaceId: space, memoryId: memory, limit: 2, cursor: `h1:${category}:0` },
            item,
            env,
          )
          .pipe(Effect.provideService(Statement.CurrentTransformer, record));
        const captured = queries.filter(([query]) => query.includes("AS key"));
        assert.isNotEmpty(captured);
        const [query, params] = captured[0]!;
        assert.include(query, `FROM ${table} `);
        assert.match(query, /LIMIT/);
        assert.deepStrictEqual(params, [space, memory, 0, 2]);
        const details = (yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          params,
        ))
          .map((r) => r.detail)
          .join("\n");
        // Keep the actual SQLite plan in the focused-run evidence artifact.
        yield* Effect.logInfo("A2 QUERY PLAN", table, details);
        assert.match(details, /SEARCH/);
        assert.match(details, /\(space=\? AND memory_id=\?/);
        if (table === "memory_report_outbox") assert.include(details, "memory_report_memory_idx");
        assert.notMatch(details, /SCAN|TEMP B-TREE/);
      }
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "A2 resolution slot CAS keeps acceptance sticky and rolls back with its transaction",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const resolutionId = M.MemoryResolutionId.make(id(90000));
      yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${space},${resolutionId},${memory},'[]','[]','judgment','{}','{}',${env},1,${id(90001)},0,0,'{}')`;
      const baseline = (yield* sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='memory_input_bytes' AND scope_key=''`)[0]!
        .value;
      const checkInput = Effect.gen(function* () {
        const raw = (yield* sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='memory_input_bytes' AND scope_key=''`)[0]!
          .value;
        assert.strictEqual(
          raw - baseline,
          (yield* scanRevertResultBytes).find((r) => r.space === space)?.bytes ?? 0,
        );
      });
      const write = (
        n: number,
        slot: Parameters<Store.MemoryStore["Service"]["recordRevertResultTx"]>[0]["slot"],
        settlement = false,
      ) =>
        store.recordRevertResultTx({
          space,
          memoryId: memory,
          resolutionId,
          operationId: M.MemoryOperationId.make(id(n)),
          slot,
          settlement,
        });
      yield* store.transact(write(90002, { status: "pending" }));
      yield* checkInput;
      yield* store.transact(write(90003, { status: "revision_changed" }));
      yield* checkInput;
      yield* store.transact(write(90002, { status: "revert_expired" }, true));
      assert.deepStrictEqual(yield* sql`SELECT revert_operation_id FROM memory_resolutions`, [
        { revert_operation_id: id(90003) },
      ]);
      const rollback = yield* store
        .transact(write(90004, { status: "pending" }).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit);
      assert.strictEqual(rollback._tag, "Failure");
      yield* store.transact(
        write(90002, { status: "accepted", revisionId: M.MemoryRevisionId.make(id(90005)) }, true),
      );
      yield* store.transact(write(90006, { status: "forgotten" }));
      yield* store.transact(write(90007, { status: "pending" }));
      yield* store.transact(
        write(90008, { status: "accepted", revisionId: M.MemoryRevisionId.make(id(90009)) }, true),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT revert_operation_id,revert_result_json FROM memory_resolutions`,
        [
          {
            revert_operation_id: id(90002),
            revert_result_json: `{"status":"accepted","revisionId":"${id(90005)}"}`,
          },
        ],
      );
      yield* checkInput;
      yield* sql`DELETE FROM memory_resolutions WHERE space=${space} AND resolution_id=${resolutionId}`;
      assert.strictEqual(
        (yield* sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='memory_input_bytes' AND scope_key=''`)[0]!
          .value,
        0,
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect.each(["pending", "revision_changed", "revert_expired", "forgotten", "accepted"] as const)(
  "A2 reopens file SQLite with durable %s result and no body fields",
  (status) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "a2-slot-restart-" });
      const filename = `${dir}/memory.sqlite`;
      const first = Store.layer.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(runMigrations()).pipe(
            Layer.provideMerge(NodeSqliteClient.layer({ filename })),
          ),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = yield* Store.MemoryStore;
          yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${space},${id(95000)},${memory},'[]','[]','judgment','{}','{}',${env},1,${id(95001)},0,0,'{}')`;
          yield* store.transact(
            store.recordRevertResultTx({
              space,
              memoryId: memory,
              resolutionId: M.MemoryResolutionId.make(id(95000)),
              operationId: M.MemoryOperationId.make(id(95002)),
              slot:
                status === "accepted"
                  ? { status, revisionId: M.MemoryRevisionId.make(id(95003)) }
                  : { status },
            }),
          );
        }).pipe(Effect.provide(first)),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT revert_operation_id,json_extract(revert_result_json,'$.status') AS status,json_extract(revert_result_json,'$.revisionId') AS revision_id FROM memory_resolutions`,
            [
              {
                revert_operation_id: id(95002),
                status,
                revision_id: status === "accepted" ? id(95003) : null,
              },
            ],
          );
          assert.isEmpty(yield* sql`SELECT 1 FROM memory_payloads`);
          yield* assertUsageCounters;
        }).pipe(
          Effect.provide(
            Store.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

// Synthetic checkpoint has the same resolve R and accepted revert X on both devices.
const decodeCheckpointResolution = Schema.decodeUnknownSync(M.MemoryResolution);
const acceptedRevertCheckpoint = () => {
  const base = checkpoint();
  const original = base.revisions[0]!;
  const secondOp = operation(4);
  const resolveOp = operation(5);
  const revertOp = operation(6);
  if (secondOp.kind === "forget" || resolveOp.kind === "forget" || revertOp.kind === "forget")
    throw new Error("fixture");
  const inputs = [original.revision.revisionId, secondOp.revision.revisionId];
  const resolved = { ...resolveOp.revision, parents: inputs };
  const reverted = { ...revertOp.revision, parents: [resolved.revisionId] };
  const resolution = decodeCheckpointResolution({
    resolutionId: id(900),
    memorySpaceId: space,
    memoryId: memory,
    inputRevisionIds: inputs,
    inputPayloadRefs: inputs,
    judgmentRef: id(900),
    requestedModelSelection: { instanceId: "fixture", model: "synthetic" },
    effectiveProvider: "codex",
    effectiveModel: "synthetic",
    resolvingEnvironmentId: env,
    fencingToken: 1,
    resultRevisionId: resolved.revisionId,
    appliedAtUtc: now,
    revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
  });
  const compact = (revision: M.MemoryRevision, sequence: number): M.MemoryCompactReceipt => ({
    ...base.compactReceipts[0]!,
    revisionId: revision.revisionId,
    receipt: {
      ...base.compactReceipts[0]!.receipt,
      operationId: revision.operationId,
      hubSequence: sequence,
    },
  });
  const resolveReceipt: M.MemoryCompactReceipt = {
    ...compact(resolved, 3),
    operationKind: "resolve",
    resolutionId: resolution.resolutionId,
    attemptId: M.MemoryOperationId.make(id(901)),
    fencingToken: 1,
    receipt: {
      ...compact(resolved, 3).receipt,
      resolutionApproval: {
        resolutionId: resolution.resolutionId,
        appliedAtUtc: resolution.appliedAtUtc,
        revertDeadlineUtc: resolution.revertDeadlineUtc,
      },
    },
    reportGuard: {
      reportId: "b".repeat(64),
      resolvingEnvironmentId: env,
      resolutionId: resolution.resolutionId,
      outcome: "resolved",
    },
  };
  const revertReceipt: M.MemoryCompactReceipt = {
    ...compact(reverted, 4),
    operationKind: "revert",
    resolutionId: resolution.resolutionId,
    revertsResolutionId: resolution.resolutionId,
    reportGuard: {
      reportId: "c".repeat(64),
      resolvingEnvironmentId: env,
      resolutionId: resolution.resolutionId,
      outcome: "reverted",
    },
  };
  return {
    ...base,
    checkpointSequence: 4,
    causalBoundary: { ...base.causalBoundary, checkpointSequence: 4 },
    items: [{ ...base.items[0]!, revision: reverted } as M.MemoryItem],
    revisions: [
      original,
      { revision: secondOp.revision, payload: secondOp.payload },
      { revision: resolved, payload: resolveOp.payload },
      { revision: reverted, payload: revertOp.payload },
    ],
    resolutions: [{ resolution, payload: null }],
    compactReceipts: [
      base.compactReceipts[0]!,
      compact(secondOp.revision, 2),
      resolveReceipt,
      revertReceipt,
    ],
    fences: [{ ...base.fences[0]!, highestFencingToken: 1 }],
  } satisfies M.MemoryHubCheckpointPage;
};
it.effect.each([false, true])(
  "A2 bootstrap restores accepted correlation across split pages: %s",
  (split) =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const full = acceptedRevertCheckpoint();
      const identity = { ...fixtureCheckpointIdentity, expectedCheckpointSequence: 4 };
      assert.isTrue(M.validateMemoryCheckpointRecords([full]));
      // Original device's durable settlement, then a genuinely empty member store.
      yield* store.transact(
        store.advanceBootstrapTx({
          ...identity,
          expectedState: "unbound",
          nextState: "staging",
          snapshotToken: identity.expectedSnapshotToken,
          checkpointSequence: 4,
          nextCursor: null,
        }),
      );
      yield* store.installCheckpointPage({ ...identity, page: full });
      yield* store.completeCheckpoint({ ...identity, pageCount: 1 });
      const source = (yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 100 },
        (yield* store.readAccess(space, memory)).item!,
        env,
      )).page.revertResults;
      assert.strictEqual(source[0]?.status, "accepted");
      assert.strictEqual(source[0]?.operationId, full.compactReceipts[3]!.receipt.operationId);
      assert.isTrue(
        source[0]?.status === "accepted" &&
          source[0].receipt.revisionId === full.revisions[3]!.revision.revisionId,
      );
      const replica = Effect.gen(function* () {
        const fresh = yield* Store.MemoryStore;
        assert.isUndefined((yield* fresh.readAccess(space, memory)).item);
        yield* fresh.transact(
          fresh.advanceBootstrapTx({
            ...identity,
            expectedState: "unbound",
            nextState: "staging",
            snapshotToken: identity.expectedSnapshotToken,
            checkpointSequence: 4,
            nextCursor: null,
          }),
        );
        const pages: M.MemoryHubCheckpointPage[] = split
          ? [
              { ...full, resolutions: [], nextCursor: "next", bootstrapComplete: false },
              {
                ...full,
                pageOrdinal: 1,
                items: [],
                revisions: [],
                compactReceipts: [],
                identities: [],
                fences: [],
                resolutions: full.resolutions,
              },
            ]
          : [full];
        for (const page of pages) yield* fresh.installCheckpointPage({ ...identity, page });
        yield* fresh.completeCheckpoint({ ...identity, pageCount: pages.length });
        const history = (yield* fresh.historyPage(
          { memorySpaceId: space, memoryId: memory, limit: 100 },
          (yield* fresh.readAccess(space, memory)).item!,
          env,
        )).page;
        assert.isNull(history.nextCursor);
        assert.deepStrictEqual(history.revertResults, source);
      });
      yield* replica.pipe(checkUsage, Effect.provide(Layer.fresh(live)));
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "A2 live revision keyset survives deletion and sees only insertions ahead of cursor",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(decision());
      const item = (yield* store.readAccess(space, memory)).item!;
      const insert = (row: number, n: number) =>
        sql`INSERT INTO memory_revisions(rowid,space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) SELECT ${row},space,${id(n)},memory_id,${id(n + 1)},parents_json,scope_json,assertion_kind,provenance_json,NULL,created_at FROM memory_revisions LIMIT 1`;
      yield* insert(10, 70001);
      const first = (yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 1 },
        item,
        env,
      )).page;
      yield* insert(11, 70003);
      yield* sql`DELETE FROM memory_revisions WHERE rowid=1`;
      // Reuse behind the cursor is visible only when restarting.
      yield* insert(1, 70005);
      const rest = (yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 100, cursor: first.nextCursor! },
        item,
        env,
      )).page;
      assert.deepStrictEqual(
        rest.revisions.map((r) => r.revision.revisionId),
        [id(70001), id(70003)],
      );
      const restart = (yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 100 },
        item,
        env,
      )).page;
      assert.deepStrictEqual(
        restart.revisions.map((r) => r.revision.revisionId),
        [id(70005), id(70001), id(70003)],
      );
    }).pipe(checkUsage, Effect.provide(live)),
);

it.effect(
  "A2 UTF-8 page overflow retries the candidate and rejects a single oversized candidate",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.apply(decision());
      const item = (yield* store.readAccess(space, memory)).item!;
      const body = {
        text: "한".repeat(1000),
        evidence: [{ origin: "user", messageIds: ["m".repeat(30000)] }],
        derivedFromMemoryRevisions: [],
      };
      yield* sql`UPDATE memory_payloads SET body_json=${JSON.stringify(body)}`;
      yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) SELECT space,${id(71001)},memory_id,body_json,dependencies_json FROM memory_payloads LIMIT 1`;
      yield* sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) SELECT space,${id(71001)},memory_id,${id(71002)},parents_json,scope_json,assertion_kind,provenance_json,${id(71001)},created_at FROM memory_revisions LIMIT 1`;
      const first = (yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 100 },
        item,
        env,
      )).page;
      assert.lengthOf(first.revisions, 1);
      assert.isAtMost(new TextEncoder().encode(JSON.stringify(first)).length, 65536);
      const next = (yield* store.historyPage(
        { memorySpaceId: space, memoryId: memory, limit: 100, cursor: first.nextCursor! },
        item,
        env,
      )).page;
      assert.strictEqual(next.revisions[0]?.revision.revisionId, id(71001));
      assert.isAtMost(new TextEncoder().encode(JSON.stringify(next)).length, 65536);
      // Large valid revision metadata makes the single pair exceed the page budget.
      yield* sql`UPDATE memory_payloads SET body_json=${JSON.stringify({ ...body, evidence: [{ origin: "user", messageIds: ["m".repeat(60000)] }] })}`;
      yield* sql`UPDATE memory_revisions SET provenance_json=${JSON.stringify({ environmentId: "e".repeat(3000) })}`;
      const error = yield* store
        .historyPage({ memorySpaceId: space, memoryId: memory, limit: 100 }, item, env)
        .pipe(Effect.flip);
      assert.instanceOf(error, Store.MemoryStoreConflict);
      assert.strictEqual(error.code, "payload_too_large");
    }).pipe(checkUsage, Effect.provide(live)),
);
