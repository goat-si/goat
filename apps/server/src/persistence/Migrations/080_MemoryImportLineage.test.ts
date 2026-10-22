import * as Settings from "../../serverSettings.ts";
import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Service from "../../memory/MemoryService.ts";
import * as Quota from "../../memory/MemoryQuotaService.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Repository from "../../project/RepositoryIdentityResolver.ts";
import * as Store from "../../memory/MemoryStore.ts";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "installs one body-free table, one lookup index and three delta triggers without changing search counters",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`INSERT INTO memory_search_counters VALUES ('synthetic','user',7,5,123)`;
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 80 }), [
        [80, "MemoryImportLineage"],
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_search_counters`, [
        { space: "synthetic", scope_key: "user", eligible: 7, indexed: 5, text_bytes: 123 },
      ]);
      const triggers =
        yield* sql`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_import_lineage'`;
      assert.strictEqual(triggers.length, 3);
      const indexes =
        yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_import_lineage' AND sql IS NOT NULL`;
      assert.strictEqual(indexes.length, 1);
      yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys)
      VALUES ('synthetic','memory','{}','{}',20000,0)`;
      const counters = () =>
        sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
      const before = yield* counters();
      yield* sql`INSERT INTO memory_import_lineage VALUES ('synthetic','memory','sourceKey','key','{}')`;
      assert.deepStrictEqual(
        yield* sql`SELECT value FROM memory_quota_counters WHERE dimension='import_lineage_bytes'`,
        [{ value: 2 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger`,
        [{ reserve_bytes: 20066, reserve_keys: 1 }],
      );
      const inserted = yield* counters();
      yield* sql`INSERT INTO memory_import_lineage VALUES ('synthetic','memory','sourceKey','key','{}') ON CONFLICT DO NOTHING`;
      assert.deepStrictEqual(yield* counters(), inserted);
      yield* sql`UPDATE memory_import_lineage SET record_json='{"x":1}'`;
      assert.deepStrictEqual(
        yield* sql`SELECT value FROM memory_quota_counters WHERE dimension='import_lineage_bytes'`,
        [{ value: 7 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger`,
        [{ reserve_bytes: 20071, reserve_keys: 1 }],
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM memory_import_lineage`;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        yield* sql`SELECT value FROM memory_quota_counters WHERE dimension='import_lineage_bytes'`,
        [{ value: 7 }],
      );
      yield* sql`DELETE FROM memory_import_lineage`;
      assert.deepStrictEqual(
        yield* sql`SELECT reserve_bytes,reserve_keys FROM memory_identity_ledger`,
        [{ reserve_bytes: 20000, reserve_keys: 0 }],
      );
      // Generation is monotonic; all byte/row counters return to the original allocation.
      const withoutGeneration = (rows: readonly { readonly [key: string]: unknown }[]) =>
        rows.filter((r) => r.dimension !== "hub_snapshot_generation" && r.value !== 0);
      assert.deepStrictEqual(withoutGeneration(yield* counters()), withoutGeneration(before));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each(["event", "compact", "hubReceipt"] as const)(
  "refuses publication and history deletion after upgrading incomplete approved 074 import history: %s",
  (evidence) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
      const memoryId = M.MemoryId.make("00000000-0000-4000-8000-000000000002");
      const environmentId = M.EnvironmentId.make("synthetic-legacy");
      const sourceId = M.MemoryImportSourceId.make("00000000-0000-4000-8000-000000000003");
      yield* sql`INSERT INTO memory_identity_ledger VALUES (${space},${memoryId},${json({ memorySpaceId: space, memoryId, scope: { kind: "user" }, creatingEnvironmentId: environmentId, createOperationId: "00000000-0000-4000-8000-000000000010", createdAtUtc: "1970-01-01T00:00:00.000Z" })},${json({ memorySpaceId: space, memoryId, highestFencingToken: 0, activeLease: null })},20000,0)`;
      const records: M.MemoryImportLineageRecord[] = [];
      for (let n = 0; n < 2; n++) {
        const op = `00000000-0000-4000-8000-00000000001${n}`;
        const provenance = {
          environmentId,
          importSource: {
            sourceId,
            format: "codex",
            parserVersion: "synthetic-v1",
            sourceLocator: "memory.md",
            sourceItemKey: `key-${n}`,
            sourceFingerprint: String(n).repeat(64),
            contentFingerprint: String(n).repeat(64),
            sourceAliases: [],
            acceptedContentFingerprints: [],
          },
        };
        yield* sql`INSERT INTO memory_revisions VALUES (${space},${op},${memoryId},${op},'[]','{"kind":"user"}','inference',${JSON.stringify(provenance)},NULL,0)`;
        const receipt: M.MemoryHubReceipt = {
          operationId: M.MemoryOperationId.make(op),
          memoryId,
          operationDigest: "a".repeat(64),
          outcome: "accepted",
          hubSequence: n + 1,
        };
        if (evidence === "event")
          yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at)
          VALUES (1,${space},${memoryId},${op},'upsert',${environmentId},${receipt.operationDigest},'{}',${json(receipt)},0)`;
        else if (evidence === "compact")
          yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json)
          VALUES (${space},${op},${receipt.operationDigest},${receipt.hubSequence},${json(receipt)},${json({ memorySpaceId: space, originEnvironmentId: environmentId, operationKind: "upsert", receipt, revisionId: op, resolutionId: null, revertsResolutionId: null, attemptId: null, fencingToken: null, reportGuard: null })})`;
        else
          yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json)
          VALUES (${space},'hubReceipt',${op},${memoryId},${json({ memoryId, receipt })})`;
        records.push(
          {
            memorySpaceId: space,
            memoryId,
            kind: "sourceKey",
            sourceKey: { environmentId, sourceId, sourceItemKey: `key-${n}` },
          },
          {
            memorySpaceId: space,
            memoryId,
            kind: "content",
            content: {
              scope: { kind: "user" },
              assertionKind: "inference",
              contentFingerprint: String(n).repeat(64),
            },
          },
        );
      }
      yield* runMigrations({ toMigrationInclusive: 80 });
      yield* runMigrations();
      // A structurally valid staged page isolates the lineage guard from ordinary
      // missing-page refusal. Without the guard publication really advances the floor.
      const page: M.MemoryHubCheckpointPage = {
        memorySpaceId: space,
        checkpointSequence: 2,
        retentionFloor: 0,
        causalBoundary: { checkpointSequence: 2, boundaryId: "a".repeat(64) },
        pageOrdinal: 0,
        items: [],
        revisions: [],
        tombstones: [],
        conflicts: [],
        resolutions: [],
        compactReceipts: [],
        identities: [],
        fences: [],
        suppressions: [],
        importLineage: [],
        nextCursor: null,
        bootstrapComplete: true,
      };
      assert.isTrue(M.validateMemoryCheckpointRecords([page]));
      yield* sql`INSERT INTO memory_hub_retention(space) VALUES (${space})`;
      yield* sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,missing_parents_json,reason,hub_sequence,checkpoint_id,page_ordinal,metadata_json)
        VALUES (${space},'hub:synthetic-checkpoint:0','checkpoint','[]','hub_snapshot',2,'hub:synthetic-checkpoint',0,${JSON.stringify(page)})`;
      const snapshot = Effect.gen(function* () {
        return {
          revisions: yield* sql`SELECT * FROM memory_revisions ORDER BY revision_id`,
          events: yield* sql`SELECT * FROM memory_events ORDER BY sequence`,
          counters:
            yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
          retention: yield* sql`SELECT * FROM memory_hub_retention`,
          identities: yield* sql`SELECT * FROM memory_identity_ledger`,
          lineage: yield* sql`SELECT * FROM memory_import_lineage`,
          staging: yield* sql`SELECT * FROM memory_inbox_pending`,
        };
      });
      const store = yield* Store.MemoryStore;
      const before = yield* snapshot;
      yield* Effect.gen(function* () {
        const service = yield* Service.MemoryService;
        const failure = yield* service.importPorts
          .readItem(
            { memorySpaceId: space, environmentId, sourceId, sourceItemKey: "key-0" },
            Effect.void,
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryStoreConflict");
        if (failure._tag === "MemoryStoreConflict")
          assert.strictEqual(failure.code, "bootstrap_required");
      }).pipe(
        Effect.provide(
          Service.layer.pipe(
            Layer.provide(
              Layer.succeed(Settings.MemoryHubCommittedSettings, {
                read: Effect.succeed({
                  provenance: null,
                  settings: { mode: "hub" as const, memorySpaceId: space },
                  version: 1,
                }),
              }),
            ),
            Layer.provide(Quota.layer),
            Layer.provide(Layer.succeed(Store.MemoryStore, store)),
            Layer.provide(
              Layer.succeed(Environment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(environmentId),
              }),
            ),
            Layer.provide(
              Layer.mock(Repository.RepositoryIdentityResolver)({
                resolve: () => Effect.succeed(null),
              }),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(yield* snapshot, before);

      const publication = {
        memorySpaceId: space,
        checkpointId: "synthetic-checkpoint",
        expectedFloor: 0,
        nextFloor: 2,
        now: 9000000000,
      };
      for (const action of [
        store.publishCheckpointAndFloorTx(publication),
        store.compactEligibleHistoryTx({ ...publication, limit: 100 }),
        store.requireImportLineageCompleteTx(space),
      ]) {
        const failure = yield* store.transact(action).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryStoreConflict");
        if (failure._tag === "MemoryStoreConflict")
          assert.strictEqual(failure.code, "bootstrap_required");
        assert.deepStrictEqual(yield* snapshot, before);
      }
      // A complete canonical ledger passes; no automatic backfill is attempted by the guard.
      yield* store.transact(store.unionImportLineageTx(records, Store.approvedReplica));
      yield* store.transact(store.requireImportLineageCompleteTx(space));
    }).pipe(
      Effect.provide(
        Store.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
);
