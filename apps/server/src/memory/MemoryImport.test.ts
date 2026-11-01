import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import {
  uuid,
  space,
  memoryId,
  environmentId,
  sourceId,
  address,
  stamp,
  identity,
  resolver,
  registration,
  setupImport,
  authority,
  seedMember,
  encodeUnknown,
} from "./MemoryImport.testkit.ts";
import { checkpointLedgerFixture } from "./MemoryCheckpoint.testkit.ts";
import * as Settings from "../serverSettings.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/078_Memory.ts";
import hubMigration from "../persistence/Migrations/079_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/080_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/082_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/083_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/095_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/084_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/085_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/086_MemoryRevertResults.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Schema from "effect/Schema";
import type { PreparedImportCommit, ImportItem } from "./imports/MemoryImportTypes.ts";
import * as Store from "./MemoryStore.ts";

const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(searchMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const live = Store.layer.pipe(Layer.provideMerge(database));
const record = (n: number): M.MemoryImportLineageRecord => ({
  memorySpaceId: space,
  memoryId,
  kind: "sourceKey",
  sourceKey: {
    environmentId,
    sourceId: M.MemoryImportSourceId.make(uuid(3)),
    sourceItemKey: `synthetic-${n}`,
  },
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys)
    VALUES (${space},${memoryId},${checkpointLedgerFixture(space, memoryId, environmentId).identity},${checkpointLedgerFixture(space, memoryId, environmentId).fence},20000,0)`;
});
const inventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    counters: yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
    identity: yield* sql`SELECT * FROM memory_identity_ledger`,
    lineage: yield* sql`SELECT * FROM memory_import_lineage ORDER BY space,memory_id,kind,key`,
  };
});
describe("MemoryImport lifetime lineage", () => {
  it.effect("admits equality, refuses +1 atomically and preserves duplicate noop at capacity", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.MemoryStore;
      yield* store.transact(
        store.unionImportLineageTx(
          Array.from({ length: 1000 }, (_, n) => record(n)),
          Store.hubAdmission,
        ),
      );
      const before = yield* inventory;
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 1000);
      const failure = yield* store
        .transact(store.unionImportLineageTx([record(1000)], Store.hubAdmission))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryCapacityError");
      if (failure._tag === "MemoryCapacityError") {
        assert.strictEqual(failure.dimension, "import_lineage_records");
        assert.strictEqual(failure.current, 1001);
      }
      assert.deepStrictEqual(yield* inventory, before);
      yield* store.transact(store.unionImportLineageTx([record(999)], Store.hubAdmission));
      assert.deepStrictEqual(yield* inventory, before);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "enforces global encoded-byte equality/+1 and rolls back reserve, generation and metadata",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const bytes = new TextEncoder().encode(JSON.stringify(record(0))).length;
        yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_LINEAGE_MAX_BYTES - bytes}
        WHERE space='_hub_global' AND dimension='import_lineage_bytes'`;
        yield* store.transact(store.unionImportLineageTx([record(0)], Store.hubAdmission));
        const before = yield* inventory;
        const failure = yield* store
          .transact(store.unionImportLineageTx([record(1)], Store.hubAdmission))
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryCapacityError");
        if (failure._tag === "MemoryCapacityError")
          assert.strictEqual(failure.dimension, "import_lineage_bytes");
        assert.deepStrictEqual(yield* inventory, before);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "approved replica restores complete canonical union despite local record and byte limits",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_LINEAGE_MAX_BYTES}
        WHERE space='_hub_global' AND dimension='import_lineage_bytes'`;
        const store = yield* Store.MemoryStore;
        yield* store.transact(
          store.unionImportLineageTx(
            Array.from({ length: 1001 }, (_, n) => record(n)),
            Store.approvedReplica,
          ),
        );
        assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 1001);
      }).pipe(checkUsage, Effect.provide(live)),
  );
});

const serviceLayer = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
    }),
  ),
  Layer.provide(identity),
  Layer.provide(resolver),
);
const importLive = serviceLayer.pipe(
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(live))),
);
const prepared = (
  reg = registration(),
  n = 10,
  previous: ImportItem | null = null,
): PreparedImportCommit => {
  const operationId = M.MemoryOperationId.make(uuid(n));
  const revisionId = M.MemoryRevisionId.make(uuid(n + 1));
  const sourceFingerprint = (previous ? "c" : "a").repeat(64);
  const contentFingerprint = (previous ? "d" : "b").repeat(64);
  const scope: M.MemoryScope = { kind: "user" };
  const result: M.MemoryImportItemResult = {
    sourceItemKey: "synthetic-item",
    outcome: previous ? "revised" : "created",
    memoryId,
    revisionId,
  };
  const selection = {
    selector: { sourceItemKey: "synthetic-item", sourceFingerprint, scope },
    memoryId,
    operationId,
    revisionId,
    result,
  };
  const batchId = M.MemoryOperationId.make(uuid(n + 2));
  return {
    registrationVersion: reg.version,
    registration: reg,
    selection,
    batch: {
      ...address,
      kind: "detailed",
      codecVersion: 1,
      operationId: batchId,
      sourceId,
      sessionId: "session-1",
      selectionDigest: "e".repeat(64),
      selections: [selection],
      createdAtUtc: stamp,
      receipt: {
        operationId: batchId,
        sourceId,
        sessionId: "session-1",
        state: "completed",
        remaining: 0,
        sessionNewItems: 0,
        sessionBodyBytes: 0,
        items: [result],
      },
    },
    candidate: {
      sourceItemKey: "synthetic-item",
      sourceFingerprint,
      contentFingerprint,
      byteCount: 16,
      payload: {
        text: previous ? "synthetic changed" : "synthetic memory",
        evidence: [{ origin: "import", importSourceId: sourceId, messageIds: [] }],
        derivedFromMemoryRevisions: [],
      },
    },
    previous,
    next: {
      ...address,
      sourceId,
      codecVersion: 1,
      sourceItemKey: "synthetic-item",
      scope,
      memoryId,
      accepted: previous?.accepted ?? null,
      pending: { sourceFingerprint, contentFingerprint, revisionId, operationId },
      rejected: null,
      outcome: result.outcome,
    },
    expectedHeads: previous?.accepted ? [previous.accepted.revisionId] : [],
    parents: previous?.accepted ? [previous.accepted.revisionId] : [],
    projectBinding: null,
  };
};
const durableInventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    imports: yield* sql`SELECT * FROM memory_import_receipts ORDER BY receipt_id`,
    noopResults:
      yield* sql`SELECT * FROM memory_import_noop_results ORDER BY space,environment_id,source_id,result_ref`,
    outbox: yield* sql`SELECT * FROM memory_outbox ORDER BY id`,
    events: yield* sql`SELECT * FROM memory_events ORDER BY sequence`,
    revisions: yield* sql`SELECT * FROM memory_revisions ORDER BY revision_id`,
    payloads: yield* sql`SELECT * FROM memory_payloads ORDER BY payload_ref`,
    counters: yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
  };
});
// A fresh database models the hub; its approval cannot mutate the origin item fixture.
const remoteApproval = (
  operation: M.MemoryOperation,
  forgotten = false,
  predecessors: readonly M.MemoryOperation[] = [],
) =>
  Effect.gen(function* () {
    yield* seedMember;
    const service = yield* Service.MemoryService;
    if (forgotten) {
      const operationId = M.MemoryOperationId.make(uuid(800));
      yield* (yield* Store.MemoryStore).transact(
        service.admitHubOperationTx({
          authority,
          operation: {
            protocolVersion: 1,
            kind: "forget",
            memorySpaceId: space,
            memoryId,
            operationId,
            originEnvironmentId: environmentId,
            expectedHeads: [],
            tombstone: {
              memorySpaceId: space,
              memoryId,
              deleteOperationId: operationId,
              deletingEnvironmentId: environmentId,
              deletedAtUtc: stamp,
              suppressedSourceKeys: [],
              suppressedContent: [],
              sourceExclusions: [],
            },
          },
        }),
      );
    }
    for (const predecessor of predecessors)
      yield* (yield* Store.MemoryStore).transact(
        service.admitHubOperationTx({ authority, operation: predecessor }),
      );
    return yield* (yield* Store.MemoryStore).transact(
      service.admitHubOperationTx({ authority, operation }),
    );
  }).pipe(Effect.provide(Layer.fresh(importLive)));
const decodeReceiptEnvelope = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ receipt: M.MemoryImportReceipt })),
);
const retired = Effect.fnUntraced(function* (p: PreparedImportCommit) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE memory_import_receipts SET completed_items_json=${encodeUnknown({ kind: "retired", codecVersion: 1, selectionDigest: p.batch.selectionDigest })}
    WHERE space=${space} AND environment_id=${environmentId} AND record_kind='batch' AND batch_operation_id=${p.batch.operationId}`;
});
describe("MemoryImport durable ports", () => {
  it.effect(
    "persists registration sessions, enforces slot/version CAS and rejects private excess fields",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const ports = service.importPorts;
        assert.deepStrictEqual(
          yield* ports.readRegistration(
            { ...address, by: "slot", slot: registration().slot },
            Effect.void,
          ),
          registration(),
        );
        const changed = {
          ...registration(),
          version: 1,
          session: { ...registration().session!, profile: "updated" },
        };
        yield* ports.saveRegistration(
          { ...address, next: changed, expectedVersion: 0 },
          Effect.void,
        );
        assert.strictEqual(
          (yield* ports
            .saveRegistration({ ...address, next: changed, expectedVersion: 0 }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        const conflict = yield* ports
          .saveRegistration(
            {
              ...address,
              next: {
                ...registration(),
                sourceId: M.MemoryImportSourceId.make(uuid(90)),
                source: {
                  ...registration().source,
                  sourceId: M.MemoryImportSourceId.make(uuid(90)),
                },
              },
              expectedVersion: null,
            },
            Effect.void,
          )
          .pipe(Effect.flip);
        assert.strictEqual(conflict._tag, "MemoryStoreConflict");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE memory_import_receipts SET registration_json=${encodeUnknown({ ...changed, extra: "forbidden" })} WHERE record_kind='source'`;
        assert.strictEqual(
          (yield* ports
            .readRegistration({ ...address, by: "source", sourceId }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryStorageError",
        );
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "reconstructs a fresh Service, replays committed stable IDs and keeps item/session/intent atomic",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const p = prepared();
        assert.deepStrictEqual(
          yield* service.importPorts.commit(p, Effect.void),
          p.selection.result,
        );
        const before = yield* durableInventory;
        const replay = yield* Effect.gen(function* () {
          const restarted = yield* Service.MemoryService;
          assert.deepStrictEqual(
            yield* restarted.importPorts.commit(p, Effect.void),
            p.selection.result,
          );
          return yield* restarted.importPorts.readReceipt(p.batch, Effect.void);
        }).pipe(
          Effect.provide(
            serviceLayer.pipe(
              Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
            ),
          ),
        );
        assert.strictEqual(replay.state, "completed");
        assert.strictEqual(replay.sessionNewItems, 1);
        assert.strictEqual(replay.sessionBodyBytes, 16);
        assert.deepStrictEqual(yield* durableInventory, before);
        const item = yield* service.importPorts.readItem(p.next, Effect.void);
        assert.deepStrictEqual(item, p.next);
        assert.strictEqual(
          (yield* service.importPorts.preflightBatch(
            { ...p.batch, selectionDigest: p.batch.selectionDigest },
            Effect.void,
          )).kind,
          "completed",
        );
        assert.strictEqual(
          (yield* service.importPorts
            .readReceipt({ ...p.batch, environmentId: M.EnvironmentId.make("other") }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        const store = yield* Store.MemoryStore;
        assert.strictEqual(
          (yield* store
            .transact(service.importPorts.readItem(p.next, Effect.void))
            .pipe(Effect.flip))._tag,
          "MemoryStorageError",
        );
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "rolls back every durable write on registration CAS conflict and authorization revoked after apply",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const p = prepared();
        const before = yield* durableInventory;
        const stale = yield* service.importPorts
          .commit({ ...p, registrationVersion: 99 }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "MemoryStoreConflict");
        assert.deepStrictEqual(yield* durableInventory, before);
        const permit = Effect.gen(function* () {
          if (yield* store.receipt(space, p.selection.operationId).pipe(Effect.orDie))
            return yield* new Service.MemoryAccessError({ code: "fenced" });
        });
        assert.strictEqual(
          (yield* service.importPorts.commit(p, permit).pipe(Effect.flip))._tag,
          "MemoryAccessError",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "rechecks retired guard after preflight: same digest not_found, changed digest operation_id_reused",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const first = prepared();
        const unfinished = {
          ...first.selection,
          selector: { ...first.selection.selector, sourceItemKey: "synthetic-second" },
          memoryId: M.MemoryId.make(uuid(70)),
          operationId: M.MemoryOperationId.make(uuid(71)),
          revisionId: M.MemoryRevisionId.make(uuid(72)),
          result: null,
        };
        const batch = {
          ...first.batch,
          selections: [first.selection, unfinished],
          receipt: { ...first.batch.receipt, state: "partial" as const, remaining: 1 },
        };
        yield* service.importPorts.commit({ ...first, batch }, Effect.void);
        const preflight = yield* service.importPorts.preflightBatch(
          { ...batch, selectionDigest: batch.selectionDigest },
          Effect.void,
        );
        assert.strictEqual(preflight.kind, "partial");
        if (preflight.kind !== "partial") return assert.fail("expected durable partial batch");
        assert.strictEqual(preflight.batch.selections[1]!.operationId, unfinished.operationId);
        const reg = yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        );
        const p: PreparedImportCommit = {
          ...first,
          registration: reg!,
          registrationVersion: reg!.version,
          selection: unfinished,
          batch: preflight.batch,
          candidate: { ...first.candidate, sourceItemKey: unfinished.selector.sourceItemKey },
          next: {
            ...first.next,
            sourceItemKey: unfinished.selector.sourceItemKey,
            memoryId: unfinished.memoryId,
            pending: {
              ...first.next.pending!,
              operationId: unfinished.operationId,
              revisionId: unfinished.revisionId,
            },
          },
        };
        yield* retired(p);
        const before = yield* durableInventory;
        const same = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
        assert.strictEqual(same._tag, "MemoryStoreConflict");
        if (same._tag === "MemoryStoreConflict") assert.strictEqual(same.code, "not_found");
        const changed = yield* service.importPorts
          .commit({ ...p, batch: { ...p.batch, selectionDigest: "f".repeat(64) } }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(changed._tag, "MemoryStoreConflict");
        if (changed._tag === "MemoryStoreConflict")
          assert.strictEqual(changed.code, "operation_id_reused");
        const status = yield* service.importPorts
          .readReceipt(p.batch, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(status._tag, "MemoryRpcError");
        if (status._tag === "MemoryRpcError") assert.strictEqual(status.code, "not_found");
        assert.strictEqual(
          (yield* service.importPorts.preflightBatch(
            { ...p.batch, selectionDigest: p.batch.selectionDigest },
            Effect.void,
          )).kind,
          "retired",
        );
        assert.strictEqual(
          (yield* service.importPorts
            .preflightBatch({ ...p.batch, selectionDigest: "f".repeat(64) }, Effect.void)
            .pipe(Effect.flip))._tag,
          "MemoryImportRpcError",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("revises from accepted parent and refuses stale expected heads without writes", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readWorkOperation(
        `sync:${space}:${first.selection.operationId}`,
      ))!;
      const approval = yield* remoteApproval(operation);
      assert.strictEqual(
        (yield* service.importPorts.readItem(
          { ...address, sourceId, sourceItemKey: "synthetic-item" },
          Effect.void,
        ))!.accepted,
        null,
      );
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, approval);
      const accepted = (yield* service.importPorts.readItem(
        { ...address, sourceId, sourceItemKey: "synthetic-item" },
        Effect.void,
      ))!;
      assert.deepStrictEqual(accepted.accepted, first.next.pending);
      assert.strictEqual(accepted.pending, null);
      const reg = yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      );
      const second = prepared(reg!, 30, accepted);
      const before = yield* durableInventory;
      assert.strictEqual(
        (yield* service.importPorts
          .commit({ ...second, expectedHeads: [] }, Effect.void)
          .pipe(Effect.flip))._tag,
        "MemoryStoreConflict",
      );
      assert.deepStrictEqual(yield* durableInventory, before);
      yield* service.importPorts.commit(second, Effect.void);
      const revised = yield* store.readOperation(space, second.selection.operationId);
      assert.strictEqual(revised?.kind, "upsert");
      if (revised?.kind === "upsert")
        assert.deepStrictEqual(revised.revision.parents, [first.selection.revisionId]);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "materializes unfinished selections and noop does not allocate another body, revision or intent",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const first = prepared();
        const unfinished = { ...first.selection, result: null };
        yield* service.importPorts.commit(
          {
            ...first,
            selection: unfinished,
            batch: {
              ...first.batch,
              selections: [unfinished],
              receipt: { ...first.batch.receipt, state: "partial", remaining: 1, items: [] },
            },
          },
          Effect.void,
        );
        const reg = yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        );
        const noop = prepared(reg!, 30, first.next);
        const selection = { ...noop.selection, selector: first.selection.selector, result: null };
        const p: PreparedImportCommit = {
          ...noop,
          selection,
          candidate: first.candidate,
          next: { ...first.next, outcome: "noop" },
          expectedHeads: [first.selection.revisionId],
          batch: {
            ...noop.batch,
            selections: [selection],
            receipt: { ...noop.batch.receipt, items: [], state: "partial", remaining: 1 },
          },
        };
        const target = yield* service.importPorts.prepareTarget(
          { ...address, memoryId, scope: { kind: "user" }, acceptedRevisionId: null },
          Effect.void,
        );
        assert.deepStrictEqual(target.heads, [first.selection.revisionId]);
        assert.strictEqual(target.alias, null);
        const before = yield* durableInventory;
        const scope: M.MemoryScope = {
          kind: "thread",
          thread: { environmentId, threadId: M.ThreadId.make("synthetic-thread") },
        };
        const changedSelection = { ...p.selection, selector: { ...p.selection.selector, scope } };
        const changedScope = {
          ...p,
          selection: changedSelection,
          next: { ...p.next, scope },
          batch: { ...p.batch, selections: [changedSelection] },
        };
        const denied = yield* service.importPorts
          .commit(changedScope, Effect.void)
          .pipe(Effect.flip);
        if (denied._tag === "MemoryStoreConflict")
          assert.strictEqual(denied.code, "identity_mismatch");
        else assert.fail("expected scope identity conflict");
        assert.deepStrictEqual(yield* durableInventory, before);
        const result = yield* service.importPorts.commit(p, Effect.void);
        assert.strictEqual(result.outcome, "noop");
        assert.strictEqual(result.revisionId, first.selection.revisionId);
        const after = yield* durableInventory;
        assert.deepStrictEqual(after.revisions, before.revisions);
        assert.deepStrictEqual(after.payloads, before.payloads);
        assert.deepStrictEqual(after.outbox, before.outbox);
        const receipt = yield* service.importPorts.readReceipt(p.batch, Effect.void);
        assert.strictEqual(receipt.sessionBodyBytes, 16);
        assert.strictEqual(receipt.sessionNewItems, 1);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("denies bootstrap and stale project binding without an intent or partial receipt", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const p = prepared();
      yield* sql`UPDATE memory_compaction_state SET published=0 WHERE space=${space}`;
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
      if (failure._tag === "MemoryStoreConflict")
        assert.strictEqual(failure.code, "bootstrap_required");
      else assert.fail("expected bootstrap conflict");
      assert.deepStrictEqual(yield* durableInventory, before);
      yield* sql`UPDATE memory_compaction_state SET published=1 WHERE space=${space}`;
      yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
      const project: M.ScopedProjectRef = {
        environmentId,
        projectId: M.ProjectId.make("synthetic-project"),
      };
      const projectKey: M.MemoryProjectKey = {
        kind: "explicit",
        sharedProjectId: uuid(80),
      };
      const binding: M.MemoryProjectBinding = {
        memorySpaceId: space,
        project,
        projectKey,
        repositoryKey: null,
        version: 1,
      };
      yield* store.putProjectBinding(binding, null, 0);
      const scope: M.MemoryScope = { kind: "project", projectKey };
      const selection = { ...p.selection, selector: { ...p.selection.selector, scope, project } };
      const mapped = {
        ...p,
        selection,
        next: { ...p.next, scope },
        batch: { ...p.batch, selections: [selection] },
        projectBinding: binding,
      };
      yield* store.putProjectBinding({ ...binding, version: 2 }, 1, 0);
      const snapshot = yield* durableInventory;
      const stale = yield* service.importPorts.commit(mapped, Effect.void).pipe(Effect.flip);
      if (stale._tag === "MemoryStoreConflict") assert.strictEqual(stale.code, "revision_changed");
      else assert.fail("expected project binding conflict");
      assert.deepStrictEqual(yield* durableInventory, snapshot);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "authorizes only after acquiring the writer lock when a queued import loses its grant",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const grant = yield* Ref.make(true);
        const before = yield* durableInventory;
        const holder = yield* Effect.forkChild(
          store.transact(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(entered);
        const permit = Ref.get(grant).pipe(
          Effect.flatMap((allowed) =>
            allowed ? Effect.void : Effect.fail(new Service.MemoryAccessError({ code: "fenced" })),
          ),
        );
        const queued = yield* Effect.forkChild(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(service.importPorts.commit(prepared(), permit)),
            Effect.exit,
          ),
        );
        yield* Deferred.await(started);
        yield* Ref.set(grant, false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(queued);
        assert.strictEqual(result._tag, "Failure");
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport M3c final fences", () => {
  it.effect.each([
    ["rejected", "binding"],
    ["rejected", "deletion"],
    ["suppressed", "binding"],
    ["suppressed", "deletion"],
  ] as const)("metadata %j before durable mutation", ([outcome, race]) =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
      yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
      const project: M.ScopedProjectRef = {
        environmentId,
        projectId: M.ProjectId.make("synthetic-project"),
      };
      const projectKey: M.MemoryProjectKey = { kind: "explicit", sharedProjectId: uuid(80) };
      const binding: M.MemoryProjectBinding = {
        memorySpaceId: space,
        project,
        projectKey,
        repositoryKey: null,
        version: 1,
      };
      yield* store.putProjectBinding(binding, null, 0);
      const first = prepared();
      const scope: M.MemoryScope = { kind: "project", projectKey };
      const selection = {
        ...first.selection,
        selector: { ...first.selection.selector, scope, project },
        result: null,
      };
      const p: PreparedImportCommit = {
        ...first,
        selection,
        batch: { ...first.batch, selections: [selection] },
        projectBinding: binding,
        next: {
          ...first.next,
          scope,
          outcome,
          pending: null,
          rejected:
            outcome === "rejected"
              ? {
                  sourceFingerprint: first.candidate.sourceFingerprint,
                  issue: "source_changed",
                }
              : null,
        },
      };
      // A genuine delete fence makes suppressed a valid metadata-only outcome.
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(700)),
          expectedHeads: [],
        },
        Effect.void,
      );
      yield* store.transact(
        store.unionImportLineageTx(
          [
            {
              memorySpaceId: space,
              memoryId,
              kind: "sourceKey",
              sourceKey: {
                environmentId,
                sourceId,
                sourceItemKey: first.candidate.sourceItemKey,
              },
            },
          ],
          Store.approvedReplica,
        ),
      );
      if (race === "binding") yield* store.putProjectBinding({ ...binding, version: 2 }, 1, 0);
      else yield* sql`UPDATE projection_projects SET deleted_at='2026-10-15'`;
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
      if (failure._tag !== "MemoryStoreConflict")
        return assert.fail("expected final fence conflict");
      assert.strictEqual(failure.code, race === "binding" ? "revision_changed" : "not_found");
      assert.deepStrictEqual(yield* durableInventory, before);
      if (race === "binding" && outcome === "suppressed") {
        const good = { ...p, projectBinding: { ...binding, version: 2 } };
        assert.strictEqual(
          (yield* service.importPorts.commit(good, Effect.void)).outcome,
          "suppressed",
        );
      }
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "reject-only preserves item scope and capacity details while later selections proceed",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const reg = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const attempt = prepared(reg, 30, first.next);
        const scope: M.MemoryScope = {
          kind: "thread",
          thread: { environmentId, threadId: M.ThreadId.make("synthetic-thread") },
        };
        const selection = {
          ...attempt.selection,
          selector: { ...attempt.selection.selector, scope },
          result: null,
        };
        const p: PreparedImportCommit = {
          ...attempt,
          selection,
          batch: { ...attempt.batch, selections: [selection] },
          next: first.next,
          rejectOnly: { issue: "mapping_changed" },
        };
        const { rejectOnly: _rejectOnly, ...normal } = p;
        const invalid = {
          ...normal,
          next: {
            ...first.next,
            scope,
            outcome: "rejected" as const,
            pending: null,
            rejected: {
              sourceFingerprint: p.candidate.sourceFingerprint,
              issue: "mapping_changed" as const,
            },
          },
        };
        const before = yield* durableInventory;
        assert.strictEqual(
          (yield* service.importPorts.commit(invalid, Effect.void).pipe(Effect.flip))._tag,
          "MemoryStoreConflict",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
        const result = yield* service.importPorts.commit(p, Effect.void);
        assert.strictEqual(result.issue, "mapping_changed");
        assert.deepStrictEqual(
          yield* service.importPorts.readItem(first.next, Effect.void),
          first.next,
        );
        const updated = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const second = prepared(updated, 50, first.next);
        const otherSelection = { ...second.selection, result: null };
        const capacity: M.MemoryCapacityExceeded = {
          code: "capacity_exceeded",
          dimension: "import_session_bytes",
          current: 2097153,
          limit: 2097152,
          reclaimable: 0,
        };
        const denied = {
          ...second,
          selection: otherSelection,
          batch: { ...second.batch, selections: [otherSelection] },
          next: first.next,
          rejectOnly: { issue: "capacity_exceeded" as const, capacity },
        };
        assert.deepStrictEqual(
          (yield* service.importPorts.commit(denied, Effect.void)).capacity,
          capacity,
        );
        assert.deepStrictEqual(
          yield* service.importPorts.readItem(first.next, Effect.void),
          first.next,
        );
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("rejected-only aliases a real approved target with previous CAS intact", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const rejected = prepared();
      const selection = { ...rejected.selection, result: null };
      const item: ImportItem = {
        ...rejected.next,
        pending: null,
        outcome: "rejected",
        rejected: {
          sourceFingerprint: rejected.candidate.sourceFingerprint,
          issue: "source_changed",
        },
      };
      yield* service.importPorts.commit(
        {
          ...rejected,
          selection,
          batch: { ...rejected.batch, selections: [selection] },
          next: item,
        },
        Effect.void,
      );
      const targetOp = M.MemoryOperationId.make(uuid(200));
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId,
          operationId: targetOp,
          baseBoundary: null,
          expectedHeads: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: rejected.candidate.payload,
        },
        Effect.void,
      );
      const operation = (yield* store.readOperation(space, targetOp))!;
      if (operation.kind !== "upsert") return assert.fail("expected target upsert");
      const targetRev = operation.revision.revisionId;
      yield* store.acknowledgeOutbox(`sync:${space}:${targetOp}`, yield* remoteApproval(operation));
      const target = yield* service.importPorts.prepareTarget(
        { ...address, memoryId, scope: { kind: "user" }, acceptedRevisionId: null },
        Effect.void,
      );
      assert.deepStrictEqual(target.heads, [targetRev]);
      assert.strictEqual(target.alias?.revision.revisionId, targetRev);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const alias = prepared(reg, 30, item);
      const aliasSelection = { ...alias.selection, result: null };
      const p: PreparedImportCommit = {
        ...alias,
        selection: aliasSelection,
        batch: { ...alias.batch, selections: [aliasSelection] },
        candidate: { ...alias.candidate, payload: rejected.candidate.payload },
        next: { ...alias.next, outcome: "aliased" },
        expectedHeads: target.heads,
        parents: [targetRev],
      };
      const before = yield* durableInventory;
      const stale = yield* service.importPorts
        .commit({ ...p, previous: null }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(stale._tag, "MemoryStoreConflict");
      assert.deepStrictEqual(yield* durableInventory, before);
      const sql = yield* SqlClient.SqlClient;
      const bodies = yield* sql`SELECT * FROM memory_payloads ORDER BY space,payload_ref`;
      assert.strictEqual((yield* service.importPorts.commit(p, Effect.void)).outcome, "aliased");
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_payloads ORDER BY space,payload_ref`,
        bodies,
      );
      assert.strictEqual(
        (yield* sql<{ value: number }>`SELECT value FROM memory_quota_counters
        WHERE space='_hub_global' AND dimension='import_live_bytes'`)[0]?.value,
        new TextEncoder().encode(rejected.candidate.payload.text).length,
      );
      const op = yield* store.readOperation(space, p.selection.operationId);
      if (op?.kind !== "upsert") return assert.fail("expected alias intent");
      assert.deepStrictEqual(op.revision.parents, [targetRev]);
      assert.strictEqual(op.revision.payloadRef, operation.revision.payloadRef);
      const aliasUsage = yield* store.usage(space, { kind: "user" });
      assert.isAbove(aliasUsage.liveBytes, 0);
      assert.strictEqual(aliasUsage.historyBytes, 0);
      assert.strictEqual(
        (yield* store.loadAggregate(space, memoryId)).revisions.find(
          (r) => r.revision.revisionId === op.revision.revisionId,
        )?.revision.payloadRef,
        operation.revision.payloadRef,
      );
      assert.strictEqual(
        (yield* service.importPorts.readReceipt(p.batch, Effect.void)).sessionBodyBytes,
        0,
      );
      assert.deepStrictEqual(
        (yield* service.importPorts.readItem(item, Effect.void))?.pending,
        p.next.pending,
      );
      const aliasApproval = yield* remoteApproval(op, false, [operation]);
      assert.strictEqual(aliasApproval.outcome, "accepted");
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, aliasApproval);
      assert.deepStrictEqual(
        (yield* service.importPorts.readItem(item, Effect.void))?.accepted,
        p.next.pending,
      );
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 2);
      // Expired scheduling on a shared historical ref must not purge a live alias head.
      yield* sql`UPDATE memory_payloads SET purge_eligible_after=0,replaced_at=0 WHERE payload_ref=${op.revision.payloadRef}`;
      yield* store.prunePayloads(
        Date.parse(stamp) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS + 1,
        32,
      );
      assert.strictEqual((yield* sql`SELECT * FROM memory_payloads`).length, 1);
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport settlement", () => {
  it.effect("settles metadata-only pull without depending on an ACK writer", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readWorkOperation(
        `sync:${space}:${first.selection.operationId}`,
      ))!;
      assert.strictEqual(operation.kind, "upsert");
      if (operation.kind !== "upsert") return;
      const receipt = yield* remoteApproval(operation);
      yield* store.transact(
        store.settleMetadataEntryTx({
          memorySpaceId: space,
          entry: {
            kind: "metadata",
            operationKind: "upsert",
            hubSequence: receipt.hubSequence!,
            receipt,
            memoryId,
            revision: operation.revision,
          },
        }),
      );
      const item = (yield* service.importPorts.readItem(
        { ...address, sourceId, sourceItemKey: "synthetic-item" },
        Effect.void,
      ))!;
      assert.deepStrictEqual(item.accepted, first.next.pending);
      assert.strictEqual(item.pending, null);
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 2);
      const before = yield* durableInventory;
      yield* store.transact(
        store.settleMetadataEntryTx({
          memorySpaceId: space,
          entry: {
            kind: "metadata",
            operationKind: "upsert",
            hubSequence: receipt.hubSequence!,
            receipt,
            memoryId,
            revision: operation.revision,
          },
        }),
      );
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );

  it.effect("settles actual hub rejection on ACK and preserves charges across replay", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readWorkOperation(
        `sync:${space}:${first.selection.operationId}`,
      ))!;
      const refusal = yield* remoteApproval(operation, true);
      assert.strictEqual(refusal.outcome, "rejected");
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, refusal);
      const item = (yield* service.importPorts.readItem(
        { ...address, sourceId, sourceItemKey: "synthetic-item" },
        Effect.void,
      ))!;
      assert.strictEqual(item.pending, null);
      assert.strictEqual(item.accepted, null);
      assert.strictEqual(item.outcome, "rejected");
      const receipt = yield* service.importPorts.readReceipt(first.batch, Effect.void);
      assert.strictEqual(receipt.items[0]!.outcome, "rejected");
      assert.strictEqual(receipt.sessionNewItems, 1);
      const before = yield* durableInventory;
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, refusal);
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "settles a pulled canonical operation and retires only settled expired batch details",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const operation = (yield* store.readWorkOperation(
          `sync:${space}:${first.selection.operationId}`,
        ))!;
        const receipt = yield* remoteApproval(operation);
        yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
        // Still pending on the origin: expiry cannot discard the detailed receipt.
        assert.strictEqual(
          (yield* store.transact(store.readImportBatchTx(first.batch)))?.kind,
          "detailed",
        );
        yield* store.transact(
          service.settleHubEntryTx({
            memorySpaceId: space,
            localEnvironmentId: environmentId,
            hubEnvironmentId: environmentId,
            entry: {
              kind: "operation",
              hubSequence: receipt.hubSequence!,
              operation,
              receipt,
            },
          }),
        );
        assert.strictEqual(
          (yield* service.importPorts.readItem(
            { ...address, sourceId, sourceItemKey: "synthetic-item" },
            Effect.void,
          ))!.pending,
          null,
        );
        const guard = yield* store.transact(store.readImportBatchTx(first.batch));
        assert.strictEqual(guard?.kind, "retired");
        // Fixed ASCII tag/version and a 64-byte hex digest have no escaping expansion.
        assert.isAtMost(
          new TextEncoder().encode(JSON.stringify(guard)).length,
          M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
        );
        const before = yield* durableInventory;
        const failure = yield* service.importPorts.commit(first, Effect.void).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryStoreConflict");
        if (failure._tag === "MemoryStoreConflict") assert.strictEqual(failure.code, "not_found");
        assert.deepStrictEqual(yield* durableInventory, before);
        const changed = yield* service.importPorts
          .preflightBatch({ ...first.batch, selectionDigest: "f".repeat(64) }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(changed._tag, "MemoryImportRpcError");
      }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport target frontiers", () => {
  it.effect("prepares exact multi-head conflict and identifies a compacted accepted base", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const operation = (yield* store.readOperation(space, first.selection.operationId))!;
      const approval = yield* remoteApproval(operation);
      yield* store.acknowledgeOutbox(`sync:${space}:${first.selection.operationId}`, approval);
      const previous = (yield* service.importPorts.readItem(first.next, Effect.void))!;
      yield* seedMember;
      for (const n of [210, 220]) {
        const operationId = M.MemoryOperationId.make(uuid(n));
        const revisionId = M.MemoryRevisionId.make(uuid(n + 1));
        yield* service.admitHubOperation({
          authority,
          operation: {
            protocolVersion: 1,
            kind: "upsert",
            memorySpaceId: space,
            memoryId,
            operationId,
            originEnvironmentId: environmentId,
            expectedHeads: [first.selection.revisionId],
            revision: {
              memorySpaceId: space,
              memoryId,
              operationId,
              revisionId,
              payloadRef: revisionId,
              parents: [first.selection.revisionId],
              scope: { kind: "user" },
              assertionKind: "inference",
              provenance: { environmentId },
              createdAtUtc: stamp,
            },
            payload: { ...first.candidate.payload, text: `synthetic branch ${n}` },
          },
        });
      }
      const target = yield* service.importPorts.prepareTarget(
        {
          ...address,
          memoryId,
          scope: { kind: "user" },
          acceptedRevisionId: first.selection.revisionId,
        },
        Effect.void,
      );
      assert.strictEqual(target.heads.length, 2);
      assert.strictEqual(target.acceptedParent?.status, "retained");
      assert.strictEqual(target.alias, null);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const attempt = prepared(reg, 30, previous);
      const selection = { ...attempt.selection, result: null };
      const conflict = {
        ...attempt,
        selection,
        batch: { ...attempt.batch, selections: [selection] },
        expectedHeads: target.heads,
        next: { ...attempt.next, outcome: "conflicted" as const },
      };
      assert.strictEqual(
        (yield* service.importPorts.commit(conflict, Effect.void)).outcome,
        "conflicted",
      );
      // Actual compact receipt membership, not a guessed timestamp/UUID, proves compaction.
      yield* store.persistCompactReceipt({
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "upsert",
        receipt: approval,
        revisionId: first.selection.revisionId,
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      });
      const boundary = {
        checkpointSequence: approval.hubSequence!,
        boundaryId: "synthetic-boundary",
      };
      yield* sql`UPDATE memory_compaction_state SET boundary_json=${encodeUnknown(boundary)} WHERE space=${space}`;
      yield* sql`DELETE FROM memory_revisions WHERE space=${space} AND revision_id=${first.selection.revisionId}`;
      const compacted = yield* service.importPorts.prepareTarget(
        {
          ...address,
          memoryId,
          scope: { kind: "user" },
          acceptedRevisionId: first.selection.revisionId,
        },
        Effect.void,
      );
      assert.strictEqual(compacted.acceptedParent?.status, "compacted");
      assert.strictEqual(compacted.heads.length, 3);
      const updated = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const p = prepared(updated, 50, conflict.next);
      const unfinished = { ...p.selection, result: null };
      const before = yield* durableInventory;
      const failure = yield* service.importPorts
        .commit(
          {
            ...p,
            selection: unfinished,
            batch: { ...p.batch, selections: [unfinished] },
            expectedHeads: compacted.heads,
            next: { ...p.next, outcome: "conflicted" },
          },
          Effect.void,
        )
        .pipe(Effect.flip);
      if (failure._tag !== "MemoryStoreConflict")
        return assert.fail("expected compacted base conflict");
      assert.strictEqual(failure.code, "base_compacted");
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport lifetime forget fragments", () => {
  it.effect(
    "submits the full lifetime union as immutable bounded pending fragments and settles ACK links",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const store = yield* Store.MemoryStore;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const operation = (yield* store.readOperation(space, first.selection.operationId))!;
        yield* store.acknowledgeOutbox(
          `sync:${space}:${first.selection.operationId}`,
          yield* remoteApproval(operation),
        );
        yield* store.transact(
          store.unionImportLineageTx(
            Array.from({ length: 203 }, (_, n) => record(n)),
            Store.hubAdmission,
          ),
        );
        const ledger = yield* store.readImportLineage(space, memoryId);
        const operationId = M.MemoryOperationId.make(uuid(600));
        const request = {
          memorySpaceId: space,
          memoryId,
          operationId,
          expectedHeads: [first.selection.revisionId],
        };
        const base = yield* service.forget(request, Effect.void);
        assert.strictEqual(base.receipt.forgetExpansion?.status, "pending");
        assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
        assert.strictEqual((yield* durableInventory).payloads.length, 0);
        const operations: M.MemoryOperation[] = [];
        let id = operationId;
        for (;;) {
          const op = (yield* store.readOperation(space, id))!;
          assert.strictEqual(op.kind, "forget");
          if (op.kind !== "forget") return assert.fail("expected forget fragment");
          assert.isAtMost(
            op.tombstone.suppressedSourceKeys.length +
              op.tombstone.suppressedContent.length +
              op.tombstone.sourceExclusions.length,
            100,
          );
          operations.push(op);
          const receipt = (yield* store.receipt(space, id))!;
          if (!receipt.receipt.forgetExpansion) break;
          assert.strictEqual(receipt.receipt.forgetExpansion.status, "pending");
          id = receipt.receipt.forgetExpansion.operationId;
        }
        assert.strictEqual(operations.length, 3);
        assert.strictEqual((yield* store.readSuppressions(space, memoryId)).length, ledger.length);
        const before = yield* durableInventory;
        assert.deepStrictEqual(yield* service.forget(request, Effect.void), base);
        assert.deepStrictEqual(yield* durableInventory, before);
        for (const op of operations) {
          const receipt = yield* remoteApproval(op);
          yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, receipt);
          if (op.operationId === operationId) {
            // A base can compact while its independently delivered expansion is still pending.
            yield* store.persistCompactReceipt({
              memorySpaceId: space,
              originEnvironmentId: environmentId,
              operationKind: "forget",
              receipt,
              revisionId: null,
              resolutionId: null,
              revertsResolutionId: null,
              attemptId: null,
              fencingToken: null,
              reportGuard: null,
            });
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM memory_events WHERE memory_space_id=${space} AND operation_id=${operationId}`;
          }
        }
        assert.strictEqual(
          (yield* store.receipt(space, operationId))?.receipt.forgetExpansion?.status,
          "accepted",
        );
        assert.deepStrictEqual(yield* store.readImportLineage(space, memoryId), ledger);
      }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport refused forget expansion", () => {
  it.effect("preserves reserved base deletion when expansion metadata is refused", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const op = (yield* store.readOperation(space, first.selection.operationId))!;
      yield* store.acknowledgeOutbox(
        `sync:${space}:${first.selection.operationId}`,
        yield* remoteApproval(op),
      );
      yield* store.transact(
        store.unionImportLineageTx(
          Array.from({ length: 203 }, (_, n) => record(n)),
          Store.approvedReplica,
        ),
      );
      // Canonical replica restoration may leave local metadata above its admission ceiling.
      yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys)
        VALUES (${space},${M.MemoryId.make(uuid(900))},${checkpointLedgerFixture(space, uuid(900), environmentId).identity},${checkpointLedgerFixture(space, uuid(900), environmentId).fence},${M.MEMORY_PERMANENT_METADATA_MAX_BYTES},0)`;
      const result = yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(600)),
          expectedHeads: [first.selection.revisionId],
        },
        Effect.void,
      );
      assert.strictEqual(result.receipt.outcome, "deleted");
      assert.strictEqual(result.receipt.forgetExpansion?.status, "rejected");
      const expansion = (yield* store.receipt(space, result.receipt.forgetExpansion!.operationId))!;
      assert.strictEqual(expansion.receipt.outcome, "rejected");
      assert.strictEqual(expansion.receipt.failureCode, "capacity_exceeded");
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "forgotten");
      assert.strictEqual((yield* durableInventory).payloads.length, 0);
      assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 205);
      assert.strictEqual((yield* store.readSuppressions(space, memoryId)).length, 100);
      assert.strictEqual(
        (yield* service.importPorts.findMatch(
          {
            ...address,
            source: { environmentId, sourceId, sourceItemKey: "synthetic-202" },
            content: {
              scope: { kind: "user" },
              assertionKind: "inference",
              contentFingerprint: "b".repeat(64),
            },
          },
          Effect.void,
        )).kind,
        "source_suppressed",
      );
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport origin admission", () => {
  it.effect(
    "batch-only capacity rejection allocates no new identity and the following noop completes",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const sql = yield* SqlClient.SqlClient;
        const first = prepared();
        yield* service.importPorts.commit(first, Effect.void);
        const reg = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const attempt = prepared(reg, 30);
        const key = "synthetic-capacity";
        const id = M.MemoryId.make(uuid(500));
        const rejectedSelection = {
          ...attempt.selection,
          memoryId: id,
          selector: { ...attempt.selection.selector, sourceItemKey: key },
          result: null,
        };
        const noop = prepared(reg, 50, first.next);
        const noopSelection = {
          ...noop.selection,
          selector: first.selection.selector,
          result: null,
        };
        const batch = {
          ...attempt.batch,
          selections: [rejectedSelection, noopSelection],
          receipt: { ...attempt.batch.receipt, items: [], remaining: 2, state: "partial" as const },
        };
        const capacity: M.MemoryCapacityExceeded = {
          code: "capacity_exceeded",
          dimension: "import_source_items",
          current: M.MEMORY_IMPORT_MAX_SOURCE_ITEMS + 1,
          limit: M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
          reclaimable: 0,
        };
        yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_MAX_SOURCE_ITEMS - 1} WHERE space='_hub_global' AND dimension='import_source_items'`;
        const next = {
          ...attempt.next,
          sourceItemKey: key,
          memoryId: id,
          outcome: "rejected" as const,
          pending: null,
          rejected: {
            sourceFingerprint: attempt.candidate.sourceFingerprint,
            issue: "capacity_exceeded" as const,
          },
        };
        const result = yield* service.importPorts.commit(
          {
            ...attempt,
            batch,
            selection: rejectedSelection,
            candidate: { ...attempt.candidate, sourceItemKey: key },
            next,
            rejectOnly: { issue: "capacity_exceeded", capacity },
          },
          Effect.void,
        );
        assert.deepStrictEqual(result.capacity, capacity);
        assert.strictEqual(yield* service.importPorts.readItem(next, Effect.void), undefined);
        const partial = yield* service.importPorts.preflightBatch(
          { ...batch, selectionDigest: batch.selectionDigest },
          Effect.void,
        );
        if (partial.kind !== "partial") return assert.fail("expected partial batch");
        const updated = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        assert.strictEqual(
          (yield* service.importPorts.commit(
            {
              ...noop,
              registration: updated,
              registrationVersion: updated.version,
              batch: partial.batch,
              selection: partial.batch.selections[1]!,
              candidate: first.candidate,
              next: { ...first.next, outcome: "noop" },
              expectedHeads: [first.selection.revisionId],
            },
            Effect.void,
          )).outcome,
          "noop",
        );
        const receipt = yield* service.importPorts.readReceipt(batch, Effect.void);
        assert.strictEqual(receipt.state, "completed");
        assert.strictEqual(receipt.items.length, 2);
        assert.deepStrictEqual(receipt.items[0]!.capacity, capacity);
      }).pipe(Effect.provide(importLive)),
  );

  it.effect("a rejected zero-byte observation cannot waive a later accepted session charge", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const initial = registration();
      const reg = {
        ...initial,
        version: 1,
        session: { ...initial.session!, newItems: M.MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS },
      };
      yield* service.importPorts.saveRegistration(
        { ...address, next: reg, expectedVersion: 0 },
        Effect.void,
      );
      const first = prepared(reg);
      const selection = { ...first.selection, result: null };
      const rejected = {
        ...first.next,
        outcome: "rejected" as const,
        pending: null,
        rejected: {
          sourceFingerprint: first.candidate.sourceFingerprint,
          issue: "source_changed" as const,
        },
      };
      yield* service.importPorts.commit(
        { ...first, selection, batch: { ...first.batch, selections: [selection] }, next: rejected },
        Effect.void,
      );
      const updated = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      assert.strictEqual(updated.session!.applied[0]!.bodyBytes, 0);
      const attempt = prepared(updated, 30, rejected);
      const retrySelection = {
        ...attempt.selection,
        selector: first.selection.selector,
        result: null,
      };
      const retry = {
        ...attempt,
        selection: retrySelection,
        batch: { ...attempt.batch, selections: [retrySelection] },
        candidate: first.candidate,
        next: {
          ...attempt.next,
          outcome: "created" as const,
          pending: {
            ...attempt.next.pending!,
            sourceFingerprint: first.candidate.sourceFingerprint,
            contentFingerprint: first.candidate.contentFingerprint,
          },
        },
      };
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(retry, Effect.void).pipe(Effect.flip);
      if (failure._tag !== "MemoryCapacityError")
        return assert.fail("expected accepted charge admission");
      assert.strictEqual(failure.dimension, "import_session_items");
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );

  it.effect.each([
    ["import_source_items", M.MEMORY_IMPORT_MAX_SOURCE_ITEMS, 1],
    ["import_aliases", M.MEMORY_IMPORT_MAX_ALIASES, 1],
    ["import_digests", M.MEMORY_IMPORT_MAX_CONTENT_DIGESTS, 1],
    ["import_live_items", M.MEMORY_IMPORT_MAX_LIVE_ITEMS, 1],
    ["import_live_bytes", M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES, 16],
  ] as const)("origin %j admits equality and refuses +1 atomically", ([dimension, limit, delta]) =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      // Source registrations share the item ceiling, even before their first body.
      const initial = limit - delta - Number(dimension === "import_source_items");
      yield* sql`UPDATE memory_quota_counters SET value=${initial} WHERE space='_hub_global' AND dimension=${dimension}`;
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const attempt = prepared(reg, 30);
      const key = "synthetic-second";
      const targetId = M.MemoryId.make(uuid(500));
      const selection = {
        ...attempt.selection,
        memoryId: targetId,
        selector: { ...attempt.selection.selector, sourceItemKey: key },
        result: null,
      };
      const next = { ...attempt.next, memoryId: targetId, sourceItemKey: key };
      const second = {
        ...attempt,
        selection,
        batch: { ...attempt.batch, selections: [selection] },
        candidate: { ...attempt.candidate, sourceItemKey: key },
        next,
      };
      const before = yield* durableInventory;
      const failure = yield* service.importPorts.commit(second, Effect.void).pipe(Effect.flip);
      if (failure._tag !== "MemoryCapacityError") return assert.fail("expected origin capacity");
      assert.strictEqual(failure.dimension, dimension);
      assert.isAbove(failure.current!, limit);
      assert.deepStrictEqual(yield* durableInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect.each(["import_session_items", "import_session_bytes"] as const)(
    "session %s is charged across chunks and rolls back an excess item",
    (dimension) =>
      Effect.gen(function* () {
        yield* setupImport;
        const service = yield* Service.MemoryService;
        const initial = registration();
        const reg = {
          ...initial,
          version: 1,
          session: {
            ...initial.session!,
            newItems: dimension === "import_session_items" ? 127 : 0,
            bodyBytes:
              dimension === "import_session_bytes"
                ? M.MEMORY_IMPORT_SESSION_MAX_BODY_BYTES - 16
                : 0,
          },
        };
        yield* service.importPorts.saveRegistration(
          { ...address, next: reg, expectedVersion: 0 },
          Effect.void,
        );
        const first = prepared(reg);
        yield* service.importPorts.commit(first, Effect.void);
        const updated = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        const second = prepared(updated, 30);
        const key = "synthetic-second";
        const id = M.MemoryId.make(uuid(500));
        const selection = {
          ...second.selection,
          memoryId: id,
          selector: { ...second.selection.selector, sourceItemKey: key },
          result: null,
        };
        const p = {
          ...second,
          selection,
          batch: { ...second.batch, selections: [selection] },
          candidate: { ...second.candidate, sourceItemKey: key },
          next: { ...second.next, sourceItemKey: key, memoryId: id },
        };
        const before = yield* durableInventory;
        const failure = yield* service.importPorts.commit(p, Effect.void).pipe(Effect.flip);
        if (failure._tag !== "MemoryCapacityError") return assert.fail("expected session capacity");
        assert.strictEqual(failure.dimension, dimension);
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("rejected observations allocate source/alias/digest metadata without a body", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const sql = yield* SqlClient.SqlClient;
      const first = prepared();
      const selection = { ...first.selection, result: null };
      const rejected = {
        ...first.next,
        outcome: "rejected" as const,
        pending: null,
        rejected: {
          sourceFingerprint: first.candidate.sourceFingerprint,
          issue: "source_changed" as const,
        },
      };
      yield* service.importPorts.commit(
        {
          ...first,
          selection,
          batch: { ...first.batch, selections: [selection] },
          next: rejected,
        },
        Effect.void,
      );
      const counters = yield* sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_hub_global' AND dimension LIKE 'import_%'`;
      const values = new Map(counters.map((r) => [r.dimension, r.value]));
      assert.strictEqual(values.get("import_source_items"), 1);
      assert.strictEqual(values.get("import_aliases"), 1);
      assert.strictEqual(values.get("import_digests"), 1);
      assert.strictEqual(values.get("import_live_items"), 0);
      assert.isAbove(values.get("import_metadata")!, 0);
      assert.isAbove(values.get("import_staging")!, 0);
      assert.strictEqual((yield* durableInventory).payloads.length, 0);
      const receipt = yield* service.importPorts.readReceipt(first.batch, Effect.void);
      assert.strictEqual(receipt.sessionBodyBytes, 0);
    }).pipe(Effect.provide(importLive)),
  );
});

const allMemoryInventory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_%' ORDER BY name`;
  const result: Record<string, readonly string[]> = {};
  for (const table of tables) {
    const rows = yield* sql.unsafe(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`);
    result[table.name] = rows.map((row) => encodeUnknown(row)).sort();
  }
  return result;
});
const repository = {
  canonicalKey: "github.com/synthetic/import",
  rootPath: "/synthetic",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/synthetic/import.git",
  },
};
const repositoryImportLive = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
    }),
  ),
  Layer.provide(identity),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(repository),
    }),
  ),
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(live))),
);
describe("MemoryImport M3d", () => {
  it.effect(
    "preparation binding resolves without writes and materializes only inside successful commit",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const sql = yield* SqlClient.SqlClient;
        const ports = (yield* Service.MemoryService).importPorts;
        yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
        const project = { environmentId, projectId: M.ProjectId.make("synthetic-project") };
        const before = yield* allMemoryInventory;
        const binding = yield* ports.binding({ memorySpaceId: space, project }, Effect.void);
        assert.isNotNull(binding.repositoryKey);
        assert.deepStrictEqual(yield* ports.resolveProjectKey(space, project), binding.projectKey);
        assert.deepStrictEqual(yield* allMemoryInventory, before);
        if (!binding.projectKey) return assert.fail("expected derived binding");
        const p = prepared();
        const scope: M.MemoryScope = { kind: "project", projectKey: binding.projectKey };
        const selection = { ...p.selection, selector: { ...p.selection.selector, scope, project } };
        const mapped = {
          ...p,
          selection,
          batch: { ...p.batch, selections: [selection] },
          next: { ...p.next, scope },
          projectBinding: binding,
        };
        const denied = yield* ports
          .commit({ ...mapped, expectedHeads: [M.MemoryRevisionId.make(uuid(999))] }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(denied._tag, "MemoryStoreConflict");
        assert.deepStrictEqual(yield* allMemoryInventory, before);
        yield* ports.commit(mapped, Effect.void);
        assert.strictEqual((yield* sql`SELECT * FROM memory_project_bindings`).length, 1);
      }).pipe(Effect.provide(repositoryImportLive)),
  );
  it.effect("hubReceipt-only approval refuses incomplete lineage without backfill", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const p = prepared();
      yield* service.importPorts.commit(p, Effect.void);
      const op = (yield* store.readOperation(space, p.selection.operationId))!;
      const receipt = yield* remoteApproval(op);
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, receipt);
      yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hubReceipt',${op.operationId},${memoryId},${encodeUnknown({ receipt, memoryId })})`;
      yield* sql`DELETE FROM memory_events WHERE memory_space_id=${space}`;
      yield* sql`DELETE FROM memory_compact_receipts WHERE space=${space}`;
      yield* sql`DELETE FROM memory_import_lineage WHERE space=${space}`;
      const before = yield* allMemoryInventory;
      const guard = yield* store
        .transact(store.requireImportLineageCompleteTx(space))
        .pipe(Effect.flip);
      assert.strictEqual(guard._tag, "MemoryStoreConflict");
      if (guard._tag === "MemoryStoreConflict")
        assert.strictEqual(guard.code, "bootstrap_required");
      const callback = yield* service.importPorts.readItem(p.next, Effect.void).pipe(Effect.flip);
      assert.strictEqual(callback._tag, "MemoryStoreConflict");
      if (callback._tag === "MemoryStoreConflict")
        assert.strictEqual(callback.code, "bootstrap_required");
      assert.deepStrictEqual(yield* allMemoryInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect("public receipt not_found commits lazy retirement", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const p = prepared();
      yield* service.importPorts.commit(p, Effect.void);
      const op = (yield* store.readOperation(space, p.selection.operationId))!;
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, yield* remoteApproval(op));
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
      const failure = yield* service.importPorts
        .readReceipt(p.batch, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryRpcError");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        kind: string;
      }>`SELECT json_extract(completed_items_json,'$.kind') AS kind FROM memory_import_receipts WHERE batch_operation_id=${p.batch.operationId}`;
      assert.strictEqual(rows[0]?.kind, "retired");
    }).pipe(Effect.provide(importLive)),
  );
  it.effect.each([
    "B accepted C rejected",
    "C accepted B accepted",
    "B rejected C accepted",
  ] as const)("settles delayed observations: %s", (order) =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const ports = service.importPorts;
      const a = prepared();
      yield* ports.commit(a, Effect.void);
      const aOp = (yield* store.readOperation(space, a.selection.operationId))!;
      yield* store.acknowledgeOutbox(
        `sync:${space}:${aOp.operationId}`,
        yield* remoteApproval(aOp),
      );
      const acceptedA = (yield* ports.readItem(a.next, Effect.void))!;
      const regB = (yield* ports.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const b = prepared(regB, 30, acceptedA);
      yield* ports.commit(b, Effect.void);
      const pendingB = (yield* ports.readItem(a.next, Effect.void))!;
      const regC = (yield* ports.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const cBase = prepared(regC, 50, pendingB);
      const cFingerprint = "f".repeat(64);
      const rawC = {
        ...cBase,
        candidate: { ...cBase.candidate, sourceFingerprint: cFingerprint },
        selection: {
          ...cBase.selection,
          selector: { ...cBase.selection.selector, sourceFingerprint: cFingerprint },
        },
        next: {
          ...cBase.next,
          pending: { ...cBase.next.pending!, sourceFingerprint: cFingerprint },
        },
      };
      const cSelection = {
        ...rawC.selection,
        result: { ...rawC.selection.result!, outcome: "conflicted" as const },
      };
      const c = {
        ...rawC,
        selection: cSelection,
        batch: { ...rawC.batch, selections: [cSelection] },
        next: { ...rawC.next, outcome: "conflicted" as const },
        expectedHeads: [b.selection.revisionId],
      };
      yield* ports.commit(c, Effect.void);
      const ack = (p: PreparedImportCommit, outcome: "accepted" | "rejected", sequence: number) =>
        Effect.gen(function* () {
          const saved = (yield* store.receipt(space, p.selection.operationId))!;
          const receipt: M.MemoryHubReceipt = {
            operationId: p.selection.operationId,
            memoryId,
            operationDigest: saved.operationDigest,
            outcome,
            hubSequence: outcome === "accepted" ? sequence : null,
            ...(outcome === "rejected" ? { failureCode: "forgotten" as const } : {}),
          };
          yield* store.acknowledgeOutbox(`sync:${space}:${p.selection.operationId}`, receipt);
          return receipt;
        });
      let bReceipt: M.MemoryHubReceipt;
      let cReceipt: M.MemoryHubReceipt;
      if (order === "C accepted B accepted") {
        cReceipt = yield* ack(c, "accepted", 3);
        bReceipt = yield* ack(b, "accepted", 2);
      } else {
        bReceipt = yield* ack(b, order === "B rejected C accepted" ? "rejected" : "accepted", 2);
        const intermediate = (yield* ports.readItem(a.next, Effect.void))!;
        assert.deepStrictEqual(intermediate.pending, c.next.pending);
        if (order === "B accepted C rejected")
          assert.deepStrictEqual(intermediate.accepted, b.next.pending);
        cReceipt = yield* ack(c, order === "B accepted C rejected" ? "rejected" : "accepted", 3);
      }
      const item = (yield* ports.readItem(a.next, Effect.void))!;
      assert.deepStrictEqual(
        item.accepted,
        order === "B accepted C rejected" ? b.next.pending : c.next.pending,
      );
      assert.strictEqual(item.pending, null);
      assert.strictEqual(
        (yield* ports.readReceipt(b.batch, Effect.void)).items[0]!.outcome,
        bReceipt.outcome === "rejected" ? "rejected" : "revised",
      );
      assert.strictEqual((yield* ports.readReceipt(c.batch, Effect.void)).sessionBodyBytes, 50);
      const before = yield* allMemoryInventory;
      yield* store.acknowledgeOutbox(`sync:${space}:${b.selection.operationId}`, bReceipt);
      yield* store.acknowledgeOutbox(`sync:${space}:${c.selection.operationId}`, cReceipt);
      assert.deepStrictEqual(yield* allMemoryInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
  it.effect("noop follows reused pending refusal and retains details through 30-day boundary", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const ports = service.importPorts;
      const a = prepared();
      yield* ports.commit(a, Effect.void);
      const reg = (yield* ports.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const raw = prepared(reg, 30, a.next);
      const selection = { ...raw.selection, selector: a.selection.selector, result: null };
      const noop = {
        ...raw,
        selection,
        batch: { ...raw.batch, selections: [selection] },
        candidate: a.candidate,
        next: { ...a.next, outcome: "noop" as const },
        expectedHeads: [a.selection.revisionId],
      };
      yield* ports.commit(noop, Effect.void);
      // Cancellation of transport work is not a canonical settlement.
      yield* store.finishWork(`sync:${space}:${a.selection.operationId}`, "cancelled");
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
      assert.strictEqual(
        (yield* ports.preflightBatch(
          { ...noop.batch, selectionDigest: noop.batch.selectionDigest },
          Effect.void,
        )).kind,
        "completed",
      );
      const op = (yield* store.readOperation(space, a.selection.operationId))!;
      const saved = (yield* store.receipt(space, op.operationId))!;
      const capacity: M.MemoryCapacityExceeded = {
        code: "capacity_exceeded",
        dimension: "import_lineage_records",
        current: 1001,
        limit: 1000,
        reclaimable: 0,
      };
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, {
        operationId: op.operationId,
        memoryId,
        operationDigest: saved.operationDigest,
        outcome: "rejected",
        hubSequence: null,
        failureCode: "capacity_exceeded",
        capacity,
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        completed_items_json: string;
      }>`SELECT completed_items_json FROM memory_import_receipts WHERE batch_operation_id=${noop.batch.operationId}`;
      const decoded = yield* decodeReceiptEnvelope(rows[0]!.completed_items_json);
      const receipt = decoded.receipt;
      assert.strictEqual(receipt.items[0]!.issue, "capacity_exceeded");
      assert.deepStrictEqual(receipt.items[0]!.capacity, capacity);
      const failure = yield* ports.readReceipt(noop.batch, Effect.void).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryRpcError");
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport dependent purge accounting", () => {
  it.effect("returns dependent head bytes on forget, rollback, replay and quota reuse", () =>
    Effect.gen(function* () {
      yield* setupImport;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const a = M.MemoryId.make(uuid(970));
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId: a,
          operationId: M.MemoryOperationId.make(uuid(971)),
          baseBoundary: null,
          expectedHeads: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: { text: "synthetic dependency", evidence: [], derivedFromMemoryRevisions: [] },
        },
        Effect.void,
      );
      const source = yield* store.loadAggregate(space, a);
      const first = prepared();
      yield* service.importPorts.commit(first, Effect.void);
      yield* service.upsert(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(972)),
          baseBoundary: null,
          expectedHeads: (yield* store.loadAggregate(space, memoryId)).heads,
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: {
            text: "dependent head bytes",
            evidence: [],
            derivedFromMemoryRevisions: source.heads,
          },
        },
        Effect.void,
      );
      const bytes = Effect.gen(function* () {
        return (yield* sql<{ value: number }>`SELECT value FROM memory_quota_counters
          WHERE space='_hub_global' AND dimension='import_live_bytes'`)[0]!.value;
      });
      // Resolution judgments share this table but carry no text/live-head charge.
      yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json)
        VALUES (${space},${uuid(995)},${memoryId},${encodeUnknown({ resolutionId: uuid(995), judgment: "synthetic judgment" })},'[]')`;
      assert.strictEqual(yield* bytes, 20);
      const forget = {
        memorySpaceId: space,
        memoryId: a,
        operationId: M.MemoryOperationId.make(uuid(973)),
        expectedHeads: source.heads,
      };
      const before = yield* allMemoryInventory;
      yield* store
        .transact(
          Effect.gen(function* () {
            yield* service.forget(forget, Effect.void);
            assert.strictEqual(yield* bytes, 0);
            return yield* new Store.MemoryStoreConflict({ code: "revision_changed" });
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* allMemoryInventory, before);
      yield* service.forget(forget, Effect.void);
      assert.strictEqual((yield* store.loadAggregate(space, memoryId)).item?.status, "blocked");
      assert.strictEqual(
        (yield* sql`SELECT * FROM memory_payloads WHERE memory_id=${memoryId}`).length,
        0,
      );
      assert.strictEqual(yield* bytes, 0);
      yield* service.forget(forget, Effect.void);
      assert.strictEqual(yield* bytes, 0);
      yield* service.forget(
        {
          memorySpaceId: space,
          memoryId,
          operationId: M.MemoryOperationId.make(uuid(974)),
          expectedHeads: (yield* store.loadAggregate(space, memoryId)).heads,
        },
        Effect.void,
      );
      assert.strictEqual(yield* bytes, 0);
      const reg = (yield* service.importPorts.readRegistration(
        { ...address, sourceId, by: "source" },
        Effect.void,
      ))!;
      const next = prepared(reg, 980);
      const freshId = M.MemoryId.make(uuid(990));
      const selection = {
        ...next.selection,
        memoryId: freshId,
        result: null,
        selector: { ...next.selection.selector, sourceItemKey: "quota-reuse" },
      };
      yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES - 16}
        WHERE space='_hub_global' AND dimension='import_live_bytes'`;
      yield* service.importPorts.commit(
        {
          ...next,
          selection,
          batch: { ...next.batch, selections: [selection] },
          candidate: {
            ...next.candidate,
            sourceItemKey: "quota-reuse",
            contentFingerprint: "f".repeat(64),
            payload: { ...next.candidate.payload, text: "quota reused new" },
          },
          next: {
            ...next.next,
            memoryId: freshId,
            sourceItemKey: "quota-reuse",
            pending: { ...next.next.pending!, contentFingerprint: "f".repeat(64) },
          },
        },
        Effect.void,
      );
      assert.strictEqual(yield* bytes, M.MEMORY_IMPORT_MAX_LIVE_BODY_BYTES);
    }).pipe(Effect.provide(importLive)),
  );
});

describe("MemoryImport M3d alias ownership", () => {
  it.effect("rejects forged shared payloads atomically at the canonical Store boundary", () =>
    Effect.gen(function* () {
      yield* setupImport;
      yield* seedMember;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const p = prepared();
      yield* service.importPorts.commit(p, Effect.void);
      const op = (yield* store.readOperation(space, p.selection.operationId))!;
      if (op.kind !== "upsert") return assert.fail("expected upsert");
      yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, yield* remoteApproval(op));
      const operationId = M.MemoryOperationId.make(uuid(930));
      const forged = {
        ...op,
        operationId,
        expectedHeads: [op.revision.revisionId],
        revision: {
          ...op.revision,
          operationId,
          revisionId: M.MemoryRevisionId.make(uuid(931)),
          parents: [op.revision.revisionId],
        },
        payload: { ...op.payload, text: "forged shared body" },
      };
      const before = yield* allMemoryInventory;
      const failure = yield* store
        .transact(service.admitHubOperationTx({ authority, operation: forged }))
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryStoreConflict");
      if (failure._tag === "MemoryStoreConflict")
        assert.strictEqual(failure.code, "identity_mismatch");
      assert.deepStrictEqual(yield* allMemoryInventory, before);
    }).pipe(Effect.provide(importLive)),
  );
});

// Service-level source workload. Factory integration remains a separate L4 gate.
const committedNoop = Effect.fnUntraced(function* (n: number, at = stamp, partial = false) {
  const ports = (yield* Service.MemoryService).importPorts;
  const reg = (yield* ports.readRegistration({ ...address, sourceId, by: "source" }, Effect.void))!;
  const previous = (yield* ports.readItem(
    { ...address, sourceId, sourceItemKey: "synthetic-item" },
    Effect.void,
  ))!;
  const base = prepared(reg, n, previous);
  const selection = { ...base.selection, selector: prepared().selection.selector, result: null };
  const value = {
    ...base,
    candidate: prepared().candidate,
    previous,
    next: { ...previous, outcome: "noop" as const },
    selection,
    expectedHeads: [(previous.pending ?? previous.accepted)!.revisionId],
    batch: {
      ...base.batch,
      createdAtUtc: at,
      sessionId: reg.session!.sessionId,
      receipt: { ...base.batch.receipt, sessionId: reg.session!.sessionId },
      selections: partial
        ? [
            selection,
            {
              ...selection,
              selector: { ...selection.selector, sourceItemKey: "unfinished" },
              memoryId: M.MemoryId.make(uuid(n + 4)),
              operationId: M.MemoryOperationId.make(uuid(n + 5)),
              revisionId: M.MemoryRevisionId.make(uuid(n + 6)),
            },
          ]
        : [selection],
    },
  };
  yield* ports.commit(value, Effect.void);
  return value;
});
const approvedImport = Effect.gen(function* () {
  yield* setupImport;
  const ports = (yield* Service.MemoryService).importPorts;
  const store = yield* Store.MemoryStore;
  const p = prepared();
  yield* ports.commit(p, Effect.void);
  const op = (yield* store.readOperation(space, p.selection.operationId))!;
  yield* store.acknowledgeOutbox(`sync:${space}:${op.operationId}`, yield* remoteApproval(op));
  return p;
});
describe("MemoryImport shared settled noop", () => {
  it.effect(
    "shares exact immutable items across guards and replays without the reader runtime",
    () =>
      Effect.gen(function* () {
        yield* approvedImport;
        const service = yield* Service.MemoryService;
        const sql = yield* SqlClient.SqlClient;
        const a = yield* committedNoop(400);
        const expected = yield* service.importPorts.readReceipt(a.batch, Effect.void);
        const reg = (yield* service.importPorts.readRegistration(
          { ...address, sourceId, by: "source" },
          Effect.void,
        ))!;
        yield* service.importPorts.saveRegistration(
          {
            ...address,
            expectedVersion: reg.version,
            next: {
              ...reg,
              version: reg.version + 1,
              session: {
                ...reg.session!,
                sessionId: "session-2",
                newItems: 0,
                bodyBytes: 0,
                applied: [],
              },
            },
          },
          Effect.void,
        );
        const b = yield* committedNoop(410);
        const otherReceipt = yield* service.importPorts.readReceipt(b.batch, Effect.void);
        assert.strictEqual(otherReceipt.sessionId, "session-2");
        assert.strictEqual(otherReceipt.sessionBodyBytes, 0);
        assert.strictEqual(expected.sessionBodyBytes, 16);
        assert.deepStrictEqual(otherReceipt.items, expected.items);
        const objects = yield* sql`SELECT * FROM memory_import_noop_results`;
        assert.strictEqual(objects.length, 1);
        const guards = yield* sql<{
          result_ref: string | null;
        }>`SELECT result_ref FROM memory_import_receipts WHERE batch_operation_id IN (${a.batch.operationId},${b.batch.operationId})`;
        assert.isTrue(guards.every((r) => r.result_ref !== null));
        const before = yield* durableInventory;
        // No Reader or ProviderMemoryImportRuntime is installed: any source access dies.
        const recreated = yield* Effect.service(Service.MemoryService).pipe(
          Effect.provide(serviceLayer),
        );
        const ports = recreated.importPorts;
        assert.deepStrictEqual(yield* ports.preflightBatch(a.batch, Effect.void), {
          kind: "completed",
          receipt: expected,
        });
        assert.deepStrictEqual(yield* ports.readReceipt(a.batch, Effect.void), expected);
        const changed = yield* ports
          .preflightBatch({ ...a.batch, selectionDigest: "f".repeat(64) }, Effect.void)
          .pipe(Effect.flip);
        assert.strictEqual(changed._tag, "MemoryImportRpcError");
        assert.strictEqual(
          (yield* ports
            .preflightBatch(
              { ...a.batch, environmentId: M.EnvironmentId.make("other") },
              Effect.void,
            )
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.deepStrictEqual(yield* durableInventory, before);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "converts legacy settled detail only when the exact private allocation cannot grow",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const p = prepared();
        const result = { ...p.selection.result!, outcome: "noop" as const };
        const selection = { ...p.selection, result, observation: p.next.pending!, settled: true };
        for (const env of [M.EnvironmentId.make("origin".repeat(400)), environmentId]) {
          const batch = {
            ...p.batch,
            environmentId: env,
            selections: [selection],
            receipt: { ...p.batch.receipt, items: [result] },
          };
          yield* sql`INSERT INTO memory_import_receipts(receipt_id,space,environment_id,record_kind,source_id,batch_operation_id,request_digest,completed_items_json,observed_at_utc)
          VALUES (${env},${space},${env},'batch',${sourceId},${batch.operationId},${batch.selectionDigest},${encodeUnknown(batch)},${stamp})`;
          const before = yield* sql<{
            value: number;
          }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='import_metadata'`;
          const replay = yield* store.transact(store.readImportBatchTx(batch));
          assert.strictEqual(
            replay?.kind,
            env === environmentId ? "completed-noop-ref" : "detailed",
          );
          if (replay && replay.kind !== "retired")
            assert.deepStrictEqual(replay.receipt, batch.receipt);
          const after = yield* sql<{
            value: number;
          }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='import_metadata'`;
          assert.isAtMost(after[0]!.value, before[0]!.value);
        }
        assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 1);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("retires at original 30-day boundary and collects only the final reference", () =>
    Effect.gen(function* () {
      yield* approvedImport;
      const ports = (yield* Service.MemoryService).importPorts;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* committedNoop(400);
      const later = M.MemoryUtcTimestamp.make("2026-10-16T00:00:00.000Z");
      yield* TestClock.setTime(Date.parse(later));
      const b = yield* committedNoop(410, later);
      const original = yield* ports.readReceipt(a.batch, Effect.void);
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS - 1);
      assert.deepStrictEqual(yield* ports.readReceipt(a.batch, Effect.void), original);
      yield* TestClock.adjust(1);
      assert.strictEqual((yield* ports.preflightBatch(a.batch, Effect.void)).kind, "retired");
      assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 1);
      assert.strictEqual(
        (yield* ports.readReceipt(b.batch, Effect.void)).operationId,
        b.batch.operationId,
      );
      yield* TestClock.setTime(Date.parse(later) + M.MEMORY_IMPORT_BATCH_RETENTION_MS);
      assert.strictEqual((yield* ports.preflightBatch(b.batch, Effect.void)).kind, "retired");
      assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 0);
      const changed = yield* ports
        .preflightBatch({ ...a.batch, selectionDigest: "f".repeat(64) }, Effect.void)
        .pipe(Effect.flip);
      assert.strictEqual(changed._tag, "MemoryImportRpcError");
    }).pipe(Effect.provide(importLive)),
  );
  it.effect("rolls back object insertion and final-reference retirement failures atomically", () =>
    Effect.gen(function* () {
      yield* approvedImport;
      const ports = (yield* Service.MemoryService).importPorts;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER fail_noop BEFORE INSERT ON memory_import_noop_results BEGIN SELECT RAISE(ABORT,'synthetic fault'); END`;
      const before = yield* durableInventory;
      assert.strictEqual((yield* committedNoop(400).pipe(Effect.exit))._tag, "Failure");
      assert.deepStrictEqual(yield* durableInventory, before);
      yield* sql`DROP TRIGGER fail_noop`;
      const a = yield* committedNoop(400);
      yield* sql`CREATE TRIGGER fail_gc BEFORE DELETE ON memory_import_noop_results BEGIN SELECT RAISE(ABORT,'synthetic fault'); END`;
      const retained = yield* durableInventory;
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS);
      assert.strictEqual(
        (yield* ports.readReceipt(a.batch, Effect.void).pipe(Effect.exit))._tag,
        "Failure",
      );
      assert.deepStrictEqual(yield* durableInventory, retained);
      yield* sql`DROP TRIGGER fail_gc`;
      assert.strictEqual((yield* ports.preflightBatch(a.batch, Effect.void)).kind, "retired");
    }).pipe(Effect.provide(importLive)),
  );
  it.effect.each(["hub_receipts", "hub_metadata", "import_staging"] as const)(
    "charges shared guards at exact capacity and refuses +1 atomically: %s",
    (dimension) =>
      Effect.gen(function* () {
        yield* approvedImport;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* committedNoop(400);
        const counter = Effect.gen(function* () {
          return (yield* sql<{
            value: number;
          }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension=${dimension} AND scope_key=''`)[0]!
            .value;
        });
        const before = yield* counter;
        yield* committedNoop(410);
        const delta = (yield* counter) - before;
        assert.isAbove(delta, 0);
        const usage = yield* store.transact(store.readHubUsageTx(space));
        const limit =
          dimension === "hub_receipts"
            ? M.MEMORY_DEDUP_MAX_RECEIPTS
            : dimension === "hub_metadata"
              ? M.MEMORY_PERMANENT_METADATA_MAX_BYTES
              : M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - usage.requiredCheckpointBoundBytes;
        yield* sql`UPDATE memory_quota_counters SET value=${limit - delta} WHERE space='_hub_global' AND dimension=${dimension} AND scope_key=''`;
        yield* committedNoop(420);
        assert.strictEqual(yield* counter, limit);
        yield* sql`UPDATE memory_quota_counters SET value=${limit - delta + 1} WHERE space='_hub_global' AND dimension=${dimension} AND scope_key=''`;
        const inventory = yield* durableInventory;
        const failure = yield* committedNoop(430).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryCapacityError");
        assert.deepStrictEqual(yield* durableInventory, inventory);
        assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 1);
      }).pipe(Effect.provide(importLive)),
  );
  it.effect("fails closed on collision, broken reference and forged cross-origin result", () =>
    Effect.gen(function* () {
      yield* approvedImport;
      const ports = (yield* Service.MemoryService).importPorts;
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      const a = yield* committedNoop(400);
      for (const mutation of [
        sql`UPDATE memory_import_receipts SET result_ref=NULL WHERE batch_operation_id=${a.batch.operationId}`,
        sql`UPDATE memory_import_receipts SET source_id=${uuid(999)} WHERE batch_operation_id=${a.batch.operationId}`,
        sql`UPDATE memory_import_receipts SET space=${uuid(999)} WHERE batch_operation_id=${a.batch.operationId}`,
        sql`UPDATE memory_import_receipts SET environment_id='other' WHERE batch_operation_id=${a.batch.operationId}`,
      ])
        assert.strictEqual((yield* mutation.pipe(Effect.exit))._tag, "Failure");
      yield* sql`DROP TRIGGER memory_import_result_immutable`;
      const rows = yield* sql<{
        result_json: string;
      }>`SELECT result_json FROM memory_import_noop_results`;
      const bad = JSON.parse(rows[0]!.result_json);
      bad.items[0].sourceItemKey = "forged";
      yield* sql`UPDATE memory_import_noop_results SET result_json=${encodeUnknown(bad)}`;
      const before = yield* durableInventory;
      assert.strictEqual(
        (yield* ports.readReceipt(a.batch, Effect.void).pipe(Effect.exit))._tag,
        "Failure",
      );
      assert.strictEqual((yield* committedNoop(410).pipe(Effect.exit))._tag, "Failure");
      assert.deepStrictEqual(yield* durableInventory, before);
      yield* sql`DROP TRIGGER memory_import_result_delete`;
      yield* sql`DELETE FROM memory_import_noop_results`;
      assert.strictEqual(
        (yield* ports.preflightBatch(a.batch, Effect.void).pipe(Effect.exit))._tag,
        "Failure",
      );
      yield* TestClock.setTime(Date.parse(stamp) + M.MEMORY_IMPORT_BATCH_RETENTION_MS + 1);
      assert.strictEqual(
        (yield* ports.preflightBatch(a.batch, Effect.void).pipe(Effect.exit))._tag,
        "Failure",
      );
      const broken = yield* sql<{
        kind: string;
      }>`SELECT json_extract(completed_items_json,'$.kind') AS kind FROM memory_import_receipts WHERE batch_operation_id=${a.batch.operationId}`;
      assert.strictEqual(broken[0]!.kind, "completed-noop-ref");
      assert.strictEqual(
        yield* store.transact(
          store.readImportBatchTx({ ...a.batch, memorySpaceId: M.MemorySpaceId.make(uuid(99)) }),
        ),
        undefined,
      );
      const forged =
        yield* sql`UPDATE memory_import_receipts SET environment_id='other' WHERE batch_operation_id=${a.batch.operationId}`.pipe(
          Effect.exit,
        );
      assert.strictEqual(forged._tag, "Failure");
    }).pipe(Effect.provide(importLive)),
  );
  it.effect(
    "partial and pending noop stay detailed, late acceptance shares only completed results",
    () =>
      Effect.gen(function* () {
        yield* setupImport;
        const ports = (yield* Service.MemoryService).importPorts;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const a = prepared();
        yield* ports.commit(a, Effect.void);
        const b = yield* committedNoop(400);
        const partial = yield* committedNoop(420, stamp, true);
        assert.strictEqual(
          (yield* ports.preflightBatch(partial.batch, Effect.void)).kind,
          "partial",
        );
        assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 0);
        const op = (yield* store.readOperation(space, a.selection.operationId))!;
        yield* store.acknowledgeOutbox(
          `sync:${space}:${op.operationId}`,
          yield* remoteApproval(op),
        );
        assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 1);
        assert.strictEqual(
          (yield* ports.readReceipt(b.batch, Effect.void)).items[0]!.outcome,
          "noop",
        );
        const partialAfter = yield* ports.preflightBatch(partial.batch, Effect.void);
        assert.strictEqual(partialAfter.kind, "partial");
        if (partialAfter.kind === "partial") {
          assert.strictEqual(partialAfter.batch.selections[0]!.settled, true);
          assert.strictEqual(partialAfter.batch.selections[1]!.result, null);
        }
        const c = yield* committedNoop(410);
        assert.strictEqual((yield* sql`SELECT * FROM memory_import_noop_results`).length, 1);
        const before = yield* durableInventory;
        yield* store.acknowledgeOutbox(
          `sync:${space}:${op.operationId}`,
          yield* remoteApproval(op),
        );
        assert.deepStrictEqual(yield* durableInventory, before);
        assert.strictEqual((yield* ports.preflightBatch(c.batch, Effect.void)).kind, "completed");
      }).pipe(Effect.provide(importLive)),
  );
});
