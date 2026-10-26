import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/078_Memory.ts";
import hub from "../persistence/Migrations/079_MemoryHubSync.ts";
import lineage from "../persistence/Migrations/082_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/083_MemoryCheckpointAccounting.ts";
import lifecycleMigration from "../persistence/Migrations/090_MemoryCheckpointLifecycle.ts";
import revisionSizeMigration from "../persistence/Migrations/095_MemoryRevisionCheckpointSize.ts";
import {
  CheckpointAccountingError,
  refreshCheckpointAccounting,
} from "./MemoryCheckpointAccounting.ts";
import {
  selectCheckpointMemory,
  selectCheckpointReceipt,
  checkpointInventorySize,
  emptyCheckpointInventory,
  encodeCheckpointPage,
  encodeCheckpointRecord,
  validateCheckpointInventory,
} from "./MemoryCheckpointInventory.ts";
import {
  checkpointBound,
  CHECKPOINT_PAGE_OVERHEAD,
  futureForgetReserve,
} from "./MemoryCheckpointBound.ts";
import {
  encodeCompactReceipt,
  ImportCompletedNoopCodec,
  ImportNoopResultCodec,
} from "./MemoryStore.ts";

const checkpoint = checkpointMigration.pipe(
  Effect.andThen(lifecycleMigration),
  Effect.andThen(revisionSizeMigration),
);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const environmentId = M.EnvironmentId.make('"\\한'.repeat(100));
const identity: M.MemoryIdentityRecord = {
  memorySpaceId: space,
  memoryId,
  scope: { kind: "user" },
  creatingEnvironmentId: environmentId,
  createOperationId: M.MemoryOperationId.make(id(3)),
  createdAtUtc: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
};
const fence: M.MemoryFenceRecord = {
  memorySpaceId: space,
  memoryId,
  highestFencingToken: 0,
  activeLease: null,
};
const old = Layer.effectDiscard(migration.pipe(Effect.andThen(hub), Effect.andThen(lineage))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_identity_ledger VALUES (${space},${memoryId},${JSON.stringify(identity)},${JSON.stringify(fence)},66560,0)`;
});
const counters = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
});
const readSize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    dimension: string;
    value: number;
  }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows')`;
  const m = new Map(rows.map((r) => [r.dimension, r.value]));
  return { bytes: m.get("hub_snapshot_bytes") ?? 0, rows: m.get("hub_snapshot_rows") ?? 0 };
});

it.effect(
  "upgrades 075 atomically, recalculates canonical counters, preserves pinned pages and charges private rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      // Legacy detailed/retired/pending private records are intentionally not checkpoint data.
      for (const [i, kind] of ["detailed", "retired", "detailed"].entries())
        yield* sql`INSERT INTO memory_import_receipts(receipt_id,space,environment_id,record_kind,source_id,batch_operation_id,completed_items_json,observed_at_utc) VALUES (${id(10 + i)},${space},'origin','batch',${id(30)},${id(10 + i)},${JSON.stringify({ kind, data: "\\\u0000한".repeat(100) })},'1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO memory_hub_retention(space,checkpoint_id,handles_json,published_pinned_bytes) VALUES (${space},'published','[{"checkpointId":"published"},{"checkpointId":"published"}]',37)`;
      yield* sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,missing_parents_json,reason,checkpoint_id,page_ordinal,metadata_json) VALUES (${space},'page','checkpoint','[]','hub_snapshot','hub:published',0,'{"preserve":"exact"}')`;
      // A legacy empty space must also acquire a persistent zero pair on upgrade.
      yield* sql`INSERT INTO memory_hub_retention(space) VALUES (${id(900)})`;
      const pages = yield* sql`SELECT * FROM memory_inbox_pending`;
      const retention = yield* sql`SELECT * FROM memory_hub_retention`;
      const before = yield* counters;
      const rolled = yield* sql
        .withTransaction(checkpoint.pipe(Effect.andThen(Effect.fail("interrupted"))))
        .pipe(Effect.flip);
      assert.strictEqual(rolled, "interrupted");
      assert.deepStrictEqual(yield* counters, before);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name='memory_import_noop_results'`,
        [],
      );
      assert.isFalse(
        (yield* sql<{ name: string }>`PRAGMA table_info(memory_import_receipts)`).some(
          (c) => c.name === "result_ref",
        ),
      );
      yield* sql.withTransaction(checkpoint);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_inbox_pending`, pages);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_hub_retention`, retention);
      assert.deepStrictEqual(
        yield* sql`SELECT dimension,value FROM memory_quota_counters WHERE space=${id(900)} AND dimension IN ('checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows') ORDER BY dimension`,
        [
          { dimension: "checkpoint_initialized", value: 1 },
          { dimension: "hub_snapshot_bytes", value: 0 },
          { dimension: "hub_snapshot_rows", value: 0 },
        ],
      );
      const actual = checkpointInventorySize(yield* selectCheckpointMemory(space, memoryId, 0));
      const reserve = futureForgetReserve(66560, 0);
      assert.deepStrictEqual(yield* readSize, {
        bytes: actual.bytes + reserve.bytes,
        rows: actual.rows + reserve.rows,
      });
      const after = yield* counters;
      // Noop private writes neither invalidate producer generation nor grow canonical U_next.
      yield* sql`UPDATE memory_import_receipts SET completed_items_json='{"kind":"detailed","larger":"private"}' WHERE receipt_id=${id(10)}`;
      yield* refreshCheckpointAccounting();
      assert.deepStrictEqual(yield* readSize, {
        bytes: actual.bytes + reserve.bytes,
        rows: actual.rows + reserve.rows,
      });
      assert.isTrue(after.some((r) => r.dimension === "import_staging" && Number(r.value) > 0));
      const triggers = yield* sql<{
        sql: string;
      }>`SELECT sql FROM sqlite_master WHERE name IN ('memory_import_lineage_insert','memory_import_lineage_update','memory_import_lineage_delete') AND type='trigger'`;
      assert.isTrue(
        triggers.every(
          (t) => !t.sql.includes("'hub_snapshot_bytes'") && !t.sql.includes("'hub_snapshot_rows'"),
        ),
      );
      const result = { items: [] };
      yield* sql`INSERT INTO memory_import_noop_results VALUES (${space},'origin',${id(30)},${"a".repeat(64)},1,${JSON.stringify(result)})`;
      const ref = JSON.stringify({ kind: "completed-noop-ref", resultRef: "a".repeat(64) });
      yield* sql`UPDATE memory_import_receipts SET result_ref=${"a".repeat(64)},completed_items_json=${ref} WHERE receipt_id=${id(10)}`;
      assert.isTrue(
        (yield* sql`DELETE FROM memory_import_noop_results`.pipe(Effect.exit))._tag === "Failure",
      );
      assert.isTrue(
        (yield* sql`UPDATE memory_import_receipts SET result_ref=${"b".repeat(64)} WHERE receipt_id=${id(10)}`.pipe(
          Effect.exit,
        ))._tag === "Failure",
      );
      yield* sql`UPDATE memory_import_receipts SET result_ref=NULL,completed_items_json='{"kind":"retired"}' WHERE receipt_id=${id(10)}`;
      yield* sql`DELETE FROM memory_import_noop_results`;
    }).pipe(Effect.provide(old)),
);

it.effect(
  "accounts each alias revision-payload pair and selected head transition with atomic rollback",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* checkpoint;
      const payload = {
        text: '\u0000\u0001"\\한🙂'.repeat(1000),
        evidence: [],
        derivedFromMemoryRevisions: [],
      };
      yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${id(40)},${memoryId},${JSON.stringify(payload)},'[]')`;
      for (const n of [40, 41])
        yield* sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${space},${id(n)},${memoryId},${id(n + 100)},${JSON.stringify(n === 40 ? [] : [id(40)])},'{"kind":"user"}','inference',${JSON.stringify({ environmentId, importSource: { sourceId: id(80), format: "codex", parserVersion: "v1", sourceLocator: "synthetic.md", sourceItemKey: `key-${n}`, sourceFingerprint: "a".repeat(64), contentFingerprint: "b".repeat(64), sourceAliases: [], acceptedContentFingerprints: [] } })},${id(40)},0)`;
      const item = {
        memorySpaceId: space,
        memoryId,
        status: "quarantined",
        scope: { kind: "user" },
        pendingSync: false,
        heads: [id(40), id(41)],
        localAvailability: { exposure: "held", reasons: [], deferred: [], cleanupPending: false },
      };
      // Use a valid blocked item; its heads still select both revision/payload pairs.
      const projection = {
        memorySpaceId: space,
        memoryId,
        status: "blocked",
        scope: { kind: "user" },
        pendingSync: false,
        failureCode: "missing_parent",
        localAvailability: {
          exposure: "held",
          reasons: ["missing_parent"],
          deferred: [],
          cleanupPending: false,
        },
      };
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},${memoryId},'{"kind":"user"}','user',${JSON.stringify(item.heads)},'blocked',1,${JSON.stringify(projection)},${JSON.stringify(projection.localAvailability)})`;
      yield* refreshCheckpointAccounting();
      const inventory = yield* selectCheckpointMemory(space, memoryId, 0);
      assert.strictEqual(inventory.revisions.length, 2);
      assert.deepStrictEqual(inventory.revisions[0]!.payload, inventory.revisions[1]!.payload);
      const before = yield* readSize;
      const pairBytes = new TextEncoder().encode(
        encodeCheckpointRecord(inventory.revisions[1]!),
      ).length;
      const bodyFreeBytes = new TextEncoder().encode(
        encodeCheckpointRecord({ ...inventory.revisions[1]!, payload: null }),
      ).length;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE memory_items SET heads_json=${JSON.stringify([id(40)])} WHERE space=${space}`;
            yield* refreshCheckpointAccounting();
            assert.deepStrictEqual(yield* readSize, {
              bytes: before.bytes - pairBytes + bodyFreeBytes,
              rows: before.rows,
            });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* readSize, before);
      const compact: M.MemoryCompactReceipt = {
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "upsert",
        upsertRequestDigest: "f".repeat(64),
        receipt: {
          operationId: M.MemoryOperationId.make(id(140)),
          memoryId,
          operationDigest: "a".repeat(64),
          outcome: "accepted",
          hubSequence: 1,
        },
        revisionId: M.MemoryRevisionId.make(id(40)),
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      };
      const binary = encodeCompactReceipt(compact, () => 1);
      yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob) VALUES (${space},${id(140)},${"a".repeat(64)},1,${JSON.stringify(compact.receipt)},${JSON.stringify(compact)},${binary})`;
      yield* refreshCheckpointAccounting();
      const expanded = checkpointInventorySize(yield* selectCheckpointReceipt(space, id(140)));
      assert.isTrue(expanded.bytes > binary.length);
      assert.strictEqual(binary[0], 3);
      assert.strictEqual(
        (yield* selectCheckpointReceipt(space, id(140))).compactReceipts[0]!.upsertRequestDigest,
        "f".repeat(64),
      );
      assert.deepStrictEqual(yield* readSize, {
        bytes: before.bytes + expanded.bytes,
        rows: before.rows + 1,
      });
    }).pipe(Effect.provide(old)),
);

it.effect.each([0, 1, 100, 101])(
  "literal producer bound covers %s records, escaping and framing without sixfold multiplication",
  (count) =>
    Effect.gen(function* () {
      const records = emptyCheckpointInventory();
      records.identities = Array.from({ length: count }, (_, n) => ({
        ...identity,
        memoryId: M.MemoryId.make(id(100 + n)),
      }));
      const size = checkpointInventorySize(records);
      assert.strictEqual(
        size.bytes,
        new TextEncoder().encode(records.identities.map(encodeCheckpointRecord).join("")).length,
      );
      let actual = 0;
      for (let start = 0; start < Math.max(1, count); start += 100) {
        const page: M.MemoryHubCheckpointPage = {
          memorySpaceId: space,
          checkpointSequence: Number.MAX_SAFE_INTEGER,
          retentionFloor: Number.MAX_SAFE_INTEGER,
          causalBoundary: {
            checkpointSequence: Number.MAX_SAFE_INTEGER,
            boundaryId: "f".repeat(64),
          },
          pageOrdinal: start / 100,
          ...emptyCheckpointInventory(),
          identities: records.identities.slice(start, start + 100),
          nextCursor: start + 100 < count ? "f".repeat(64) : null,
          bootstrapComplete: start + 100 >= count,
        };
        const encoded = yield* encodeCheckpointPage(page);
        const decoded = JSON.parse(encoded);
        assert.strictEqual(typeof decoded.identities[0], count === 0 ? "undefined" : "object");
        const recordBytes = checkpointInventorySize({
          ...emptyCheckpointInventory(),
          identities: page.identities.slice(),
        }).bytes;
        assert.isTrue(
          new TextEncoder().encode(encoded).length - recordBytes < CHECKPOINT_PAGE_OVERHEAD,
        );
        actual += new TextEncoder().encode(encoded).length;
      }
      assert.isTrue(actual <= checkpointBound(size.bytes, size.rows));
      assert.strictEqual(
        checkpointBound(size.bytes, size.rows),
        size.bytes + Math.max(1, count) * CHECKPOINT_PAGE_OVERHEAD,
      );
    }),
);

it.effect("private completed-noop codec slot is strict and body-free", () =>
  Effect.gen(function* () {
    const value = {
      memorySpaceId: space,
      environmentId,
      sourceId: M.MemoryImportSourceId.make(id(50)),
      kind: "completed-noop-ref",
      codecVersion: 1,
      operationId: M.MemoryOperationId.make(id(51)),
      selectionDigest: "a".repeat(64),
      sessionId: "session",
      resultRef: "b".repeat(64),
      sessionNewItems: 0,
      sessionBodyBytes: 0,
      createdAtUtc: "1970-01-01T00:00:00.000Z",
    };
    const decode = Schema.decodeUnknownEffect(ImportCompletedNoopCodec);
    yield* decode(value, { onExcessProperty: "error" });
    assert.strictEqual(
      (yield* decode({ ...value, body: "forbidden" }, { onExcessProperty: "error" }).pipe(
        Effect.exit,
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("accepts exactly 262144 encoded page bytes and refuses one more byte", () =>
  Effect.gen(function* () {
    const revision: M.MemoryRevision = {
      memorySpaceId: space,
      memoryId,
      operationId: M.MemoryOperationId.make(id(60)),
      revisionId: M.MemoryRevisionId.make(id(61)),
      parents: [],
      scope: { kind: "user" },
      payloadRef: M.MemoryRevisionId.make(id(61)),
      assertionKind: "inference",
      createdAtUtc: identity.createdAtUtc,
      provenance: { environmentId },
    };
    const pair = (text: string) => ({
      revision,
      payload: { text, evidence: [], derivedFromMemoryRevisions: [] },
    });
    const page: M.MemoryHubCheckpointPage = {
      memorySpaceId: space,
      checkpointSequence: 1,
      retentionFloor: 0,
      causalBoundary: { checkpointSequence: 1, boundaryId: "a".repeat(64) },
      pageOrdinal: 0,
      ...emptyCheckpointInventory(),
      revisions: [...Array.from({ length: 5 }, () => pair("\u0000".repeat(8000))), pair("x")],
      nextCursor: null,
      bootstrapComplete: true,
    };
    const remaining = 262144 - new TextEncoder().encode(JSON.stringify(page)).length;
    const last = pair("\u0000".repeat(Math.floor(remaining / 6)) + "x".repeat(1 + (remaining % 6)));
    const exact = { ...page, revisions: [...page.revisions.slice(0, -1), last] };
    const encoded = yield* encodeCheckpointPage(exact);
    assert.strictEqual(new TextEncoder().encode(encoded).length, 262144);
    const size = checkpointInventorySize({
      ...emptyCheckpointInventory(),
      revisions: exact.revisions.slice(),
    });
    assert.isTrue(
      new TextEncoder().encode(encoded).length <= checkpointBound(size.bytes, size.rows),
    );
    const over = {
      ...exact,
      revisions: [...exact.revisions.slice(0, -1), pair(last.payload.text + "x")],
    };
    assert.strictEqual((yield* encodeCheckpointPage(over).pipe(Effect.exit))._tag, "Failure");
  }),
);

const decodePull = Schema.decodeUnknownEffect(M.MemoryHubPullResult);
it.effect(
  "proves the single-record pull envelope at 262144 bytes and rejects unpageable admission",
  () =>
    Effect.gen(function* () {
      const page = {
        memorySpaceId: space,
        checkpointSequence: Number.MAX_SAFE_INTEGER,
        retentionFloor: Number.MAX_SAFE_INTEGER,
        causalBoundary: { checkpointSequence: Number.MAX_SAFE_INTEGER, boundaryId: "f".repeat(64) },
        pageOrdinal: Number.MAX_SAFE_INTEGER,
        ...emptyCheckpointInventory(),
        identities: [{ ...identity, creatingEnvironmentId: M.EnvironmentId.make("x") }],
        nextCursor: "f".repeat(64),
        bootstrapComplete: false,
      };
      const pull = {
        highWatermark: Number.MAX_SAFE_INTEGER,
        throughSequence: Number.MAX_SAFE_INTEGER,
        hasMore: true,
        entries: [],
        checkpoint: page,
      };
      const room = 262144 - new TextEncoder().encode(JSON.stringify(pull)).length;
      const exactIdentity = {
        ...identity,
        creatingEnvironmentId: M.EnvironmentId.make("x".repeat(room + 1)),
      };
      const exact = { ...pull, checkpoint: { ...page, identities: [exactIdentity] } };
      yield* decodePull(exact);
      assert.strictEqual(new TextEncoder().encode(JSON.stringify(exact)).length, 262144);
      const inventory = { ...emptyCheckpointInventory(), identities: [exactIdentity] };
      yield* validateCheckpointInventory(space, inventory);
      assert.isTrue(
        new TextEncoder().encode(yield* encodeCheckpointPage(exact.checkpoint)).length <=
          checkpointBound(checkpointInventorySize(inventory).bytes, 1),
      );
      assert.strictEqual(
        (yield* validateCheckpointInventory(space, {
          ...inventory,
          identities: [
            {
              ...exactIdentity,
              creatingEnvironmentId: M.EnvironmentId.make(
                exactIdentity.creatingEnvironmentId + "x",
              ),
            },
          ],
        }).pipe(Effect.exit))._tag,
        "Failure",
      );
    }),
);

const decodeNoopResult = Schema.decodeUnknownEffect(ImportNoopResultCodec);
it.effect("completed result codec slot rejects changed, empty and body-bearing objects", () =>
  Effect.gen(function* () {
    const item = {
      sourceItemKey: "synthetic",
      outcome: "noop",
      memoryId,
      revisionId: M.MemoryRevisionId.make(id(9)),
    };
    const value = { codecVersion: 1, items: [item] };
    yield* decodeNoopResult(value, { onExcessProperty: "error" });
    for (const bad of [
      { ...value, items: [] },
      { ...value, items: [{ ...item, outcome: "created" }] },
      { ...value, body: "forbidden" },
    ])
      assert.strictEqual(
        (yield* decodeNoopResult(bad, { onExcessProperty: "error" }).pipe(Effect.exit))._tag,
        "Failure",
      );
  }),
);

it.effect(
  "tracks independent lineage and suppression keys across first forget, rollback and delete",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* checkpoint;
      const record: M.MemoryImportLineageRecord = {
        memorySpaceId: space,
        memoryId,
        kind: "sourceKey",
        sourceKey: {
          environmentId,
          sourceId: M.MemoryImportSourceId.make(id(81)),
          sourceItemKey: "\u0000".repeat(512),
        },
      };
      const expected = Effect.gen(function* () {
        const size = checkpointInventorySize(yield* selectCheckpointMemory(space, memoryId, 0));
        const ledger = yield* sql<{
          reserve_bytes: number;
          reserve_keys: number;
          forgotten: number;
        }>`SELECT reserve_bytes,reserve_keys,EXISTS(SELECT 1 FROM memory_tombstones WHERE space=${space} AND memory_id=${memoryId}) AS forgotten FROM memory_identity_ledger WHERE space=${space} AND memory_id=${memoryId}`;
        const reserve = ledger[0]!.forgotten
          ? { bytes: 0, rows: 0 }
          : futureForgetReserve(ledger[0]!.reserve_bytes, ledger[0]!.reserve_keys);
        assert.deepStrictEqual(yield* readSize, {
          bytes: size.bytes + reserve.bytes,
          rows: size.rows + reserve.rows,
        });
      });
      yield* sql`INSERT INTO memory_import_lineage(space,memory_id,kind,key,record_json) VALUES (${space},${memoryId},'sourceKey','synthetic',${JSON.stringify(record)})`;
      yield* refreshCheckpointAccounting();
      yield* expected;
      const cache = yield* sql<{
        scope_key: string;
        value: number;
      }>`SELECT key AS scope_key,checkpoint_bytes AS value FROM memory_import_lineage WHERE space=${space}`;
      assert.strictEqual(cache.length, 1);
      assert.strictEqual(
        cache[0]!.value,
        new TextEncoder().encode(encodeCheckpointRecord(record)).length,
      );
      const suppression = { ...record, deleteOperationId: M.MemoryOperationId.make(id(82)) };
      yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'sourceKey','suppression',${memoryId},${JSON.stringify(suppression)})`;
      yield* refreshCheckpointAccounting();
      yield* expected;
      const before = yield* counters;
      const recordsBefore = yield* sql`SELECT rowid,* FROM memory_import_keys ORDER BY rowid`;
      const lineageBefore = yield* sql`SELECT rowid,* FROM memory_import_lineage ORDER BY rowid`;
      const missing = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_bytes' AND scope_key=''`;
            yield* sql`DELETE FROM memory_import_lineage WHERE space=${space}`;
          }),
        )
        .pipe(Effect.exit);
      assert.strictEqual(missing._tag, "Failure");
      assert.deepStrictEqual(yield* counters, before);
      assert.deepStrictEqual(
        yield* sql`SELECT rowid,* FROM memory_import_lineage ORDER BY rowid`,
        lineageBefore,
      );
      const forget = Effect.gen(function* () {
        yield* sql`INSERT INTO memory_tombstones(space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${space},${memoryId},${id(82)},${environmentId},0,'[]','[]','[]')`;
        yield* refreshCheckpointAccounting();
        yield* expected;
        assert.strictEqual(
          (yield* selectCheckpointMemory(space, memoryId, 0)).suppressions.length,
          1,
        );
      });
      yield* sql
        .withTransaction(forget.pipe(Effect.andThen(Effect.fail("interrupted"))))
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* counters, before);
      assert.deepStrictEqual(
        yield* sql`SELECT rowid,* FROM memory_import_keys ORDER BY rowid`,
        recordsBefore,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT rowid,* FROM memory_import_lineage ORDER BY rowid`,
        lineageBefore,
      );
      yield* forget;
      yield* sql`DELETE FROM memory_import_lineage WHERE space=${space} AND memory_id=${memoryId}`;
      yield* refreshCheckpointAccounting();
      yield* expected;
      yield* sql`DELETE FROM memory_tombstones WHERE space=${space} AND memory_id=${memoryId}`;
      yield* refreshCheckpointAccounting();
      yield* expected;
      assert.strictEqual(
        (yield* selectCheckpointMemory(space, memoryId, 0)).suppressions.length,
        0,
      );
      const plan = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT record_json FROM memory_import_lineage WHERE space=${space} AND memory_id=${memoryId} AND kind='sourceKey' AND key='synthetic'`;
      assert.isTrue(plan.every((r) => r.detail.includes("SEARCH")));
    }).pipe(Effect.provide(old)),
);

it.effect("keeps aggregate counter cardinality and lookup plans independent of 101 receipts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* checkpoint;
    const aggregateRows = sql<{
      n: number;
    }>`SELECT count(*) AS n FROM memory_quota_counters WHERE dimension IN ('hub_snapshot_bytes','hub_snapshot_rows')`;
    const before = yield* aggregateRows;
    for (let n = 0; n < 101; n++) {
      const record: M.MemoryCompactReceipt = {
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "upsert",
        receipt: {
          operationId: M.MemoryOperationId.make(id(1000 + n)),
          memoryId,
          operationDigest: "a".repeat(64),
          outcome: "accepted",
          hubSequence: n + 1,
        },
        revisionId: M.MemoryRevisionId.make(id(2000 + n)),
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      };
      yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob) VALUES (${space},${record.receipt.operationId},${record.receipt.operationDigest},${n + 1},${JSON.stringify(record.receipt)},${JSON.stringify(record)},${encodeCompactReceipt(record, () => 1)})`;
    }
    yield* refreshCheckpointAccounting();
    assert.deepStrictEqual(yield* aggregateRows, before);
    assert.deepStrictEqual(
      yield* sql`SELECT 1 FROM memory_quota_counters WHERE dimension IN ('hub_snapshot_bytes','hub_snapshot_rows') AND scope_key!=''`,
      [],
    );
    const encoded = yield* sql<{
      n: number;
      bytes: number;
    }>`SELECT count(*) AS n,sum(checkpoint_bytes) AS bytes FROM memory_compact_receipts WHERE checkpoint_rows=1`;
    assert.strictEqual(encoded[0]!.n, 101);
    assert.isAbove(encoded[0]!.bytes, 101 * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES);
    const spaces = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT space FROM memory_quota_counters WHERE dimension='hub_snapshot_rows' AND scope_key=''`;
    assert.isTrue(spaces.every((r) => r.detail.includes("memory_checkpoint_spaces")));
    const lifecycle = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows')`;
    assert.isTrue(
      lifecycle.every((r) => r.detail.includes("SEARCH") && r.detail.includes("INDEX")),
    );
    const owners = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT rowid FROM memory_import_keys WHERE space=${space} AND memory_id=${memoryId} AND key_kind IN ('sourceKey','content','sourceExclusion')`;
    assert.isTrue(owners.every((r) => r.detail.includes("memory_suppression_owner")));
  }).pipe(Effect.provide(old)),
);

it.effect.each([1, 100, 1000])(
  "bounds empty and one-key refresh lifecycle candidates with %s historical spaces",
  (count) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* checkpoint;
      const spaces = JSON.stringify(Array.from({ length: count }, (_, n) => id(n + 1)));
      for (const dimension of ["checkpoint_initialized", "hub_snapshot_bytes", "hub_snapshot_rows"])
        yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
          SELECT value,${dimension},'',${dimension === "checkpoint_initialized" ? 1 : 0} FROM json_each(${spaces}) WHERE 1
          ON CONFLICT(space,dimension,scope_key) DO NOTHING`;
      // Drain setup invalidations outside the measured refreshes.
      yield* sql.withTransaction(refreshCheckpointAccounting());
      for (const touched of [false, true]) {
        if (touched)
          yield* sql`UPDATE memory_identity_ledger SET reserve_keys=reserve_keys+1 WHERE space=${space} AND memory_id=${memoryId}`;
        const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        const record: Statement.Transformer = (statement) =>
          Effect.sync(() => {
            queries.push(statement.compile());
            return statement;
          });
        yield* sql
          .withTransaction(refreshCheckpointAccounting())
          .pipe(Effect.provideService(Statement.CurrentTransformer, record));
        const lifecycle = queries.filter(
          ([query]) =>
            query.includes("SELECT dimension,value FROM memory_quota_counters") &&
            query.includes("'checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows'"),
        );
        // Every candidate uses one exact space binding and at most its three PK rows.
        assert.deepStrictEqual(
          lifecycle.map(([, bindings]) => bindings),
          touched ? [[space]] : [],
        );
        assert.isTrue(lifecycle.every(([query]) => query.includes("WHERE space=?")));
        assert.isFalse(queries.some(([query]) => query.includes("SELECT DISTINCT space")));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM memory_quota_counters WHERE space IN ('_checkpoint_lifecycle','_checkpoint_dirty')`,
          [],
        );
      }
    }).pipe(Effect.provide(old)),
);

it.effect("validates and drains lifecycle addresses created by the first canonical write", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* checkpoint;
    yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES (${space},${memoryId},${JSON.stringify(identity)},${JSON.stringify(fence)},66560,0)`;
    const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        queries.push(statement.compile());
        return statement;
      });
    yield* sql
      .withTransaction(refreshCheckpointAccounting())
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    const lifecycle = queries.filter(
      ([query]) =>
        query.includes("SELECT dimension,value FROM memory_quota_counters") &&
        query.includes("'checkpoint_initialized','hub_snapshot_bytes','hub_snapshot_rows'"),
    );
    assert.deepStrictEqual(
      lifecycle.map(([, bindings]) => bindings),
      [[space], [space]],
    );
    assert.isAbove((yield* readSize).bytes, 0);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters WHERE space IN ('_checkpoint_lifecycle','_checkpoint_dirty')`,
      [],
    );
  }).pipe(Effect.provide(old)),
);

it.effect("retains the global codec initialization guard", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* checkpoint;
    // A marker value round trip queues the healthy space without changing its state.
    yield* sql`UPDATE memory_quota_counters SET value=2 WHERE space=${space} AND dimension='checkpoint_initialized' AND scope_key=''`;
    yield* sql`UPDATE memory_quota_counters SET value=1 WHERE space=${space} AND dimension='checkpoint_initialized' AND scope_key=''`;
    const pending =
      yield* sql`SELECT * FROM memory_quota_counters WHERE space='_checkpoint_lifecycle'`;
    assert.lengthOf(pending, 1);
    yield* sql`DELETE FROM memory_quota_counters WHERE space='_hub_global' AND dimension='checkpoint_codec' AND scope_key=''`;
    const failed = yield* sql.withTransaction(refreshCheckpointAccounting()).pipe(Effect.flip);
    assert.instanceOf(failed, CheckpointAccountingError);
    assert.strictEqual((failed as CheckpointAccountingError).stage, "uninitialized");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_quota_counters WHERE space='_checkpoint_lifecycle'`,
      pending,
    );
  }).pipe(Effect.provide(old)),
);

it.effect.each([50, 500])(
  "decodes only new and selected revisions per write with %s historical revisions",
  (count) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* checkpoint;
      const payload = { text: "body", evidence: [], derivedFromMemoryRevisions: [] };
      const revisionId = (n: number) => id(10000 + n);
      const addRevision = (n: number) =>
        sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${revisionId(n)},${memoryId},${JSON.stringify(payload)},'[]')`.pipe(
          Effect.andThen(
            sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${space},${revisionId(n)},${memoryId},${id(20000 + n)},${JSON.stringify(n === 0 ? [] : [revisionId(n - 1)])},'{"kind":"user"}','inference',${JSON.stringify({ environmentId })},${revisionId(n)},0)`,
          ),
        );
      const projection = {
        memorySpaceId: space,
        memoryId,
        status: "blocked",
        scope: { kind: "user" },
        pendingSync: false,
        failureCode: "missing_parent",
        localAvailability: {
          exposure: "held",
          reasons: ["missing_parent"],
          deferred: [],
          cleanupPending: false,
        },
      };
      for (let n = 0; n < count; n++) yield* addRevision(n);
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},${memoryId},'{"kind":"user"}','user',${JSON.stringify([revisionId(count - 1)])},'blocked',1,${JSON.stringify(projection)},${JSON.stringify(projection.localAvailability)})`;
      const matchesFullRecompute = Effect.gen(function* () {
        const full = checkpointInventorySize(yield* selectCheckpointMemory(space, memoryId, 0));
        const reserve = futureForgetReserve(66560, 0);
        assert.deepStrictEqual(yield* readSize, {
          bytes: full.bytes + reserve.bytes,
          rows: full.rows + reserve.rows,
        });
      });
      yield* refreshCheckpointAccounting();
      yield* matchesFullRecompute;

      yield* addRevision(count);
      yield* sql`UPDATE memory_items SET heads_json=${JSON.stringify([revisionId(count)])} WHERE space=${space}`;
      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      yield* refreshCheckpointAccounting().pipe(
        Effect.provideService(Statement.CurrentTransformer, record),
      );
      yield* matchesFullRecompute;
      const measured = queries.filter(([query]) =>
        query.startsWith("UPDATE memory_revisions SET checkpoint_bytes"),
      );
      assert.lengthOf(measured, 1);
      let selected = 0;
      for (const [query, params] of queries.filter(
        ([query]) =>
          query.startsWith("SELECT r.space,r.revision_id") &&
          query.includes("FROM memory_revisions r"),
      ))
        selected += (yield* sql.unsafe(query, params)).length;
      assert.strictEqual(selected, 1);

      // A rewritten revision is measured again instead of keeping a stale size.
      yield* sql`UPDATE memory_revisions SET provenance_json=${JSON.stringify({ environmentId: "rewritten" })} WHERE space=${space} AND revision_id=${revisionId(0)}`;
      assert.deepStrictEqual(
        yield* sql`SELECT checkpoint_bytes FROM memory_revisions WHERE space=${space} AND revision_id=${revisionId(0)}`,
        [{ checkpoint_bytes: null }],
      );
      yield* refreshCheckpointAccounting();
      yield* matchesFullRecompute;
    }).pipe(Effect.provide(old)),
);
