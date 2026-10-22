import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import * as Settings from "../serverSettings.ts";
import { McpServer } from "effect/ai";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpAccess from "../mcp/McpToolAccess.testkit.ts";
import * as McpFixture from "../mcp/toolkits/memory/handlers.testkit.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/076_Memory.ts";
import hubMigration from "../persistence/Migrations/077_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/080_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/081_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/093_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/082_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/083_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/084_MemoryRevertResults.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";

const decodeReplayReceipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const hubEnv = M.EnvironmentId.make("hub");
const memberEnv = M.EnvironmentId.make("member");
const principal = (environmentId = hubEnv): M.MemoryHubPrincipal => ({
  memorySpaceId: space,
  environmentId,
  credentialVersion: 1,
  scopes: ["memory:sync"],
});
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));
const core = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(storeLayer))),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(hubEnv),
    }),
  ),
);
const live = Layer.merge(Hub.layer, Compactor.layer).pipe(
  Layer.provideMerge(core),
  Layer.provideMerge(Hub.activityLayer),
  Layer.provide(
    Layer.succeed(Hub.MemoryHubConfiguration, {
      read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
    }),
  ),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${"a".repeat(64)},1,'active',0),(${space},${memberEnv},${"b".repeat(64)},1,'active',0)`;
});
const operation = (n = 10): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  originEnvironmentId: hubEnv,
  operationId: M.MemoryOperationId.make(id(n)),
  expectedHeads: [],
  revision: {
    memorySpaceId: space,
    memoryId,
    operationId: M.MemoryOperationId.make(id(n)),
    revisionId: M.MemoryRevisionId.make(id(n + 100)),
    parents: [],
    scope: { kind: "user" },
    payloadRef: M.MemoryRevisionId.make(id(n + 100)),
    assertionKind: "inference",
    createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
    provenance: { environmentId: hubEnv },
  },
  payload: { text: "synthetic durable memory", evidence: [], derivedFromMemoryRevisions: [] },
});
const push = (op = operation()) =>
  Effect.gen(function* () {
    return yield* (yield* Hub.MemoryHubService).push(
      { protocolVersion: 1, memorySpaceId: space, environmentId: hubEnv, operations: [op] },
      principal(),
    );
  });
const pull = (afterSequence: number, environmentId = hubEnv): M.MemoryHubPullInput => ({
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId,
  afterSequence,
  limit: 100,
});

const escapedOperation = () => {
  const base = operation(15);
  const sourceThread = {
    environmentId: hubEnv,
    threadId: M.ThreadId.make("\u0000".repeat(1024)),
  };
  const op = {
    ...base,
    revision: {
      ...base.revision,
      scope: { kind: "thread" as const, thread: sourceThread },
      provenance: {
        environmentId: hubEnv,
        upsertRequestDigest: "d".repeat(64),
        sourceThread,
        sourceWatermark: {
          fromEventId: M.EventId.make('"'.repeat(1024)),
          toEventId: M.EventId.make("\\".repeat(1024)),
          throughSequence: Number.MAX_SAFE_INTEGER,
        },
        importSource: {
          sourceId: M.MemoryImportSourceId.make(id(8000)),
          format: "codex" as const,
          parserVersion: '"'.repeat(1024),
          sourceLocator: "\u0000".repeat(1024),
          sourceItemKey: "\u0000".repeat(512),
          sourceFingerprint: "a".repeat(64),
          contentFingerprint: "b".repeat(64),
          sourceAliases: Array.from({ length: 3 }, (_, i) => ({
            environmentId: hubEnv,
            sourceId: M.MemoryImportSourceId.make(id(8100 + i)),
            sourceItemKey: "\u0000".repeat(512),
          })),
          acceptedContentFingerprints: Array.from({ length: 100 }, (_, i) =>
            String(i).padStart(64, "0"),
          ),
        },
      },
    },
    payload: {
      text: '\u0000\u0001"\\한🙂'.repeat(100),
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  };
  return op;
};

describe("MemoryCompactor", () => {
  it.effect(
    "retains 101 import deltas through real compaction, paged bootstrap and delete fences",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* Store.MemoryStore;
        let parents: readonly M.MemoryRevisionId[] = [];
        for (let n = 0; n < 101; n++) {
          const base = operation(1000 + n);
          const op = {
            ...base,
            expectedHeads: parents,
            revision: {
              ...base.revision,
              parents,
              provenance: {
                environmentId: hubEnv,
                importSource: {
                  sourceId: M.MemoryImportSourceId.make(id(9000)),
                  format: "codex" as const,
                  parserVersion: "synthetic-v1",
                  sourceLocator: "synthetic/handbook",
                  sourceItemKey: `key-${n}`,
                  sourceFingerprint: String(n).padStart(64, "0"),
                  contentFingerprint: String(n).padStart(64, "0"),
                  sourceAliases: [],
                  acceptedContentFingerprints: [],
                },
              },
            },
            payload: { ...base.payload, text: `synthetic history ${n}` },
          };
          const result = yield* push(op);
          assert.notStrictEqual(result.receipts[0]!.outcome, "rejected");
          parents = [op.revision.revisionId];
        }
        assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 202);
        yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS);
        const status = yield* (yield* Compactor.MemoryCompactor).compact(principal());
        assert.isAbove(status.compaction.removedRows, 0);
        assert.strictEqual((yield* store.readImportLineage(space, memoryId)).length, 202);
        const hub = yield* Hub.MemoryHubService;
        const joined = yield* hub.join(
          { protocolVersion: 1, memorySpaceId: space, environmentId: memberEnv },
          principal(memberEnv),
        );
        const pages: M.MemoryHubCheckpointPage[] = [];
        let cursor: string | undefined;
        for (let count = 0; count < 20; count++) {
          const pulled = yield* hub.pull(
            {
              ...pull(0, memberEnv),
              snapshotToken: joined.snapshotToken,
              ...(cursor === undefined ? {} : { cursor }),
            },
            principal(memberEnv),
          );
          const page = pulled.checkpoint!;
          pages.push(page);
          if (page.bootstrapComplete) break;
          cursor = page.nextCursor!;
        }
        assert.isAbove(pages.length, 2);
        assert.strictEqual(pages.flatMap((page) => page.importLineage).length, 202);
        assert.isTrue(M.validateMemoryCheckpointRecords(pages));
        yield* Effect.gen(function* () {
          const replica = yield* Store.MemoryStore;
          const checkpoint = {
            memorySpaceId: space,
            hubEnvironmentId: hubEnv,
            checkpointId: "synthetic-replica",
            expectedSnapshotToken: "synthetic-token",
            expectedCheckpointSequence: pages[0]!.checkpointSequence,
          };
          yield* replica.transact(
            replica.advanceBootstrapTx({
              ...checkpoint,
              expectedState: "unbound",
              nextState: "staging",
              snapshotToken: checkpoint.expectedSnapshotToken,
              checkpointSequence: checkpoint.expectedCheckpointSequence,
              nextCursor: null,
            }),
          );
          yield* replica.installCheckpointPage({ ...checkpoint, page: pages[0]! });
          assert.strictEqual((yield* replica.readImportLineage(space, memoryId)).length, 0);
          yield* replica
            .completeCheckpoint({ ...checkpoint, pageCount: pages.length })
            .pipe(Effect.flip);
          assert.strictEqual((yield* replica.readImportLineage(space, memoryId)).length, 0);
          for (const page of pages) yield* replica.installCheckpointPage({ ...checkpoint, page });
          yield* replica.completeCheckpoint({ ...checkpoint, pageCount: pages.length });
          assert.strictEqual((yield* replica.readImportLineage(space, memoryId)).length, 202);
          const service = yield* Service.MemoryService;
          yield* service.forget(
            {
              memorySpaceId: space,
              memoryId,
              operationId: M.MemoryOperationId.make(id(9900)),
              expectedHeads: parents,
            },
            Effect.void,
          );
          const match = yield* replica.transact(
            replica.findImportMatchTx({
              memorySpaceId: space,
              environmentId: memberEnv,
              source: {
                environmentId: hubEnv,
                sourceId: M.MemoryImportSourceId.make(id(9000)),
                sourceItemKey: "key-0",
              },
              content: {
                scope: { kind: "user" },
                assertionKind: "inference",
                contentFingerprint: "0".repeat(64),
              },
            }),
          );
          assert.strictEqual(match.kind, "source_suppressed");
          assert.strictEqual((yield* replica.readImportLineage(space, memoryId)).length, 202);
        }).pipe(Effect.provide(Layer.fresh(core)));
      }).pipe(checkUsage, Effect.provide(live)),
  );

  it.effect(
    "publishes a recoverable snapshot and real floor, compacts old tail and retains replay",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const first = yield* push();
        yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
        const compactor = yield* Compactor.MemoryCompactor;
        const retention = yield* compactor.compact(principal());
        assert.strictEqual(retention.checkpointSequence, 1);
        assert.strictEqual(retention.retentionFloor, 1);
        assert.strictEqual(retention.compaction.removedRows, 1);
        const hub = yield* Hub.MemoryHubService;
        assert.strictEqual(
          (yield* hub.pull(pull(0), principal()).pipe(Effect.flip))._tag,
          "MemoryHubError",
        );
        assert.strictEqual((yield* hub.pull(pull(1), principal())).entries.length, 0);
        assert.deepStrictEqual(yield* push(), first);
        const joined = yield* hub.join(
          { protocolVersion: 1, memorySpaceId: null, environmentId: memberEnv },
          principal(memberEnv),
        );
        const recovered = yield* hub.pull(
          { ...pull(0, memberEnv), snapshotToken: joined.snapshotToken },
          principal(memberEnv),
        );
        assert.strictEqual(recovered.checkpoint!.items[0]!.memoryId, memoryId);
        assert.strictEqual(recovered.checkpoint!.compactReceipts.length, 1);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("live member pin keeps the prior floor until immutable expiry", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      const hub = yield* Hub.MemoryHubService;
      yield* compactor.compact(principal());
      const joined = yield* hub.join(
        { protocolVersion: 1, memorySpaceId: space, environmentId: memberEnv },
        principal(memberEnv),
      );
      yield* push();
      const pinned = yield* compactor.compact(principal());
      assert.strictEqual(pinned.checkpointSequence, 1);
      assert.strictEqual(pinned.retentionFloor, 0);
      const old = yield* hub.pull(
        { ...pull(0, memberEnv), snapshotToken: joined.snapshotToken },
        principal(memberEnv),
      );
      assert.strictEqual(old.checkpoint!.checkpointSequence, 0);
      yield* TestClock.adjust(M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
      assert.strictEqual((yield* compactor.compact(principal())).retentionFloor, 1);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "same-hub producer preserves joined pages, token guard and floor until immutable TTL",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const compactor = yield* Compactor.MemoryCompactor;
        const hub = yield* Hub.MemoryHubService;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* push();
        const initial = yield* compactor.compact(principal());
        assert.strictEqual(initial.retentionFloor, 1);
        const joined = yield* hub.join(
          { protocolVersion: 1, memorySpaceId: space, environmentId: hubEnv },
          principal(),
        );
        const readPages = Effect.gen(function* () {
          const pages: M.MemoryHubCheckpointPage[] = [];
          let cursor: string | null = null;
          do {
            const result: M.MemoryHubPullResult = yield* hub.pull(
              {
                ...pull(0),
                snapshotToken: joined.snapshotToken,
                ...(cursor === null ? {} : { cursor }),
              },
              principal(),
            );
            const page = result.checkpoint!;
            pages.push(page);
            cursor = page.nextCursor;
          } while (cursor !== null);
          return pages;
        });
        const beforePages = yield* readPages;
        assert.strictEqual(beforePages[0]!.checkpointSequence, 1);
        assert.strictEqual(beforePages[0]!.items[0]!.memoryId, memoryId);
        const guards = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`;
        assert.strictEqual(guards.length, 1);
        const guard = JSON.parse(guards[0]!.record_json);
        assert.strictEqual(guard.retired, false);
        assert.strictEqual(guard.handle.firstIssuedAt, 0);
        assert.strictEqual(guard.handle.expiresAt, M.MEMORY_CHECKPOINT_TOKEN_TTL_MS);
        assert.strictEqual(guard.handle.credentialVersion, 1);
        const handles =
          yield* sql`SELECT handles_json FROM memory_hub_retention WHERE space=${space}`;
        const members =
          yield* sql`SELECT * FROM memory_hub_members WHERE space=${space} ORDER BY environment`;
        const next = operation(11);
        if (next.kind !== "upsert") throw new Error("expected upsert fixture");
        assert.strictEqual(
          (yield* push({
            ...next,
            expectedHeads: [M.MemoryRevisionId.make(id(110))],
            revision: { ...next.revision, parents: [M.MemoryRevisionId.make(id(110))] },
          })).receipts[0]!.outcome,
          "accepted",
        );
        for (const advance of [0, M.MEMORY_CHECKPOINT_TOKEN_TTL_MS - 1]) {
          yield* TestClock.adjust(advance);
          const published = yield* compactor.compact(principal());
          assert.strictEqual(published.checkpointSequence, 2);
          assert.notStrictEqual(published.checkpointId, initial.checkpointId);
          assert.strictEqual(published.retentionFloor, initial.retentionFloor);
          assert.deepStrictEqual(yield* readPages, beforePages);
          assert.deepStrictEqual(
            yield* sql`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`,
            guards,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT handles_json FROM memory_hub_retention WHERE space=${space}`,
            handles,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM memory_hub_members WHERE space=${space} ORDER BY environment`,
            members,
          );
        }
        yield* TestClock.adjust(1);
        const expired = yield* hub
          .pull({ ...pull(0), snapshotToken: joined.snapshotToken }, principal())
          .pipe(Effect.flip);
        assert.strictEqual(expired._tag, "MemoryHubError");
        if (expired._tag === "MemoryHubError") assert.strictEqual(expired.code, "cursor_expired");
        assert.strictEqual((yield* compactor.compact(principal())).retentionFloor, 2);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).retentionFloor,
          2,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("a failed staging reservation keeps the old publication and floor intact", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      yield* compactor.compact(principal());
      const hub = yield* Hub.MemoryHubService;
      const joined = yield* hub.join(
        { protocolVersion: 1, memorySpaceId: space, environmentId: hubEnv },
        principal(),
      );
      const beforePage = yield* hub.pull(
        { ...pull(0), snapshotToken: joined.snapshotToken },
        principal(),
      );
      yield* push();
      const initial = yield* compactor.compact(principal());
      // An unchanged replacement can retire equally sized unpinned pages without
      // growing retained bytes. Add accepted input so the next snapshot must grow.
      const next = operation(11);
      const changedMemoryId = M.MemoryId.make(id(3));
      const changed = yield* push({
        ...next,
        memoryId: changedMemoryId,
        revision: { ...next.revision, memoryId: changedMemoryId },
      });
      assert.strictEqual(changed.receipts[0]!.outcome, "accepted");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE memory_hub_retention SET published_pinned_bytes=${M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES} WHERE space=${space}`;
      const beforeRetention = yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`;
      const beforeSnapshots =
        yield* sql`SELECT * FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' ORDER BY pending_key`;
      const beforeGuards =
        yield* sql`SELECT * FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`;
      const beforeMembers =
        yield* sql`SELECT * FROM memory_hub_members WHERE space=${space} ORDER BY environment`;
      const failure = yield* compactor.compact(principal()).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MemoryCapacityError");
      if (failure._tag === "MemoryCapacityError")
        assert.strictEqual(failure.dimension, "checkpoint_staging");
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_hub_retention WHERE space=${space}`,
        beforeRetention,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' ORDER BY pending_key`,
        beforeSnapshots,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' ORDER BY key`,
        beforeGuards,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_hub_members WHERE space=${space} ORDER BY environment`,
        beforeMembers,
      );
      assert.deepStrictEqual(
        yield* hub.pull({ ...pull(0), snapshotToken: joined.snapshotToken }, principal()),
        beforePage,
      );
      const store = yield* Store.MemoryStore;
      const retained = yield* store.transact(store.readHubRetentionTx(space));
      assert.strictEqual(retained.checkpointId, initial.checkpointId);
      assert.strictEqual(retained.retentionFloor, initial.retentionFloor);
      assert.strictEqual(
        (yield* sql<{
          count: number;
        }>`SELECT count(DISTINCT checkpoint_id) AS count FROM memory_inbox_pending WHERE reason='hub_snapshot'`)[0]!
          .count,
        2,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "producer covers escaped embedded payload, maximal source fields and mixed lifetime lineage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const op = escapedOperation();
        assert.strictEqual((yield* push(op)).receipts[0]!.outcome, "accepted");
        const store = yield* Store.MemoryStore;
        const usage = yield* store.transact(store.readHubUsageTx(space));
        const result = yield* (yield* Compactor.MemoryCompactor).compact(principal());
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          metadata_json: string;
        }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND checkpoint_id=${"hub:" + result.checkpointId} ORDER BY page_ordinal`;
        assert.isAbove(rows.length, 1);
        const pages = rows.map((r) => JSON.parse(r.metadata_json) as M.MemoryHubCheckpointPage);
        assert.isTrue(M.validateMemoryCheckpointRecords(pages));
        assert.strictEqual(
          pages
            .flatMap((p) => p.compactReceipts)
            .find((r) => r.receipt.operationId === op.operationId)!.upsertRequestDigest,
          "d".repeat(64),
        );
        assert.strictEqual(
          pages.flatMap((p) => p.items).find((i) => i.status === "active")!.payload.text,
          op.payload.text,
        );
        assert.strictEqual(pages.flatMap((p) => p.revisions)[0]!.payload!.text, op.payload.text);
        assert.strictEqual(pages.flatMap((p) => p.importLineage).length, 105);
        assert.isAtMost(
          rows.reduce((sum, r) => sum + new TextEncoder().encode(r.metadata_json).length, 0),
          usage.requiredCheckpointBoundBytes,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "canonical pinned publication counts shared handles once and admits equality, rolls back plus one",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* push();
        const escaped = escapedOperation();
        const otherMemory = M.MemoryId.make(id(3));
        yield* push({
          ...escaped,
          memoryId: otherMemory,
          revision: { ...escaped.revision, memoryId: otherMemory },
        });

        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const compactor = yield* Compactor.MemoryCompactor;
        const old = yield* compactor.compact(principal());
        const authority = (environmentId = hubEnv): Store.HubAuthority => ({
          principal: principal(environmentId),
          now: Clock.currentTimeMillis,
          reauthorize: Effect.void,
        });
        for (const [environmentId, snapshotToken] of [
          [hubEnv, "shared_a"],
          [memberEnv, "shared_b"],
        ] as const)
          yield* store.transact(
            store.prepareHubCheckpointTx({
              authority: authority(environmentId),
              checkpointId: old.checkpointId!,
              snapshotToken,
              hubEnvironmentId: hubEnv,
            }),
          );
        const unique = yield* sql<{
          bytes: number;
        }>`SELECT sum(length(CAST(metadata_json AS BLOB))) AS bytes FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot'`;
        const usage = yield* store.transact(store.readHubUsageTx(space));
        assert.strictEqual(usage.liveHandles, 2);
        assert.strictEqual(usage.publishedPinnedBytes, unique[0]!.bytes);
        const next = operation(11);
        yield* push({
          ...next,
          expectedHeads: [M.MemoryRevisionId.make(id(110))],
          revision: { ...next.revision, parents: [M.MemoryRevisionId.make(id(110))] },
        });
        const publish = Effect.gen(function* () {
          const prepared = yield* store.prepareHubProducerCheckpointTx({
            authority: authority(),
            checkpointId: "equality_new",
            hubEnvironmentId: hubEnv,
          });
          yield* store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: prepared.checkpointId,
            expectedFloor: old.retentionFloor,
            nextFloor: old.retentionFloor,
            now: 0,
          });
          return yield* store.readHubUsageTx(space);
        });
        const measured = yield* store
          .transact(publish.pipe(Effect.flatMap((value) => Effect.fail(value))))
          .pipe(Effect.flip);
        if (!("stagingBytes" in measured)) throw new Error("measurement failed");
        const privateBytes = M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES - measured.stagingBytes;
        yield* sql`INSERT INTO memory_quota_counters VALUES ('_hub_global','import_staging','',${privateBytes + 1}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`;
        const snapshot = Effect.gen(function* () {
          return {
            retention: yield* sql`SELECT * FROM memory_hub_retention`,
            pages: yield* sql`SELECT * FROM memory_inbox_pending ORDER BY pending_key`,
            members: yield* sql`SELECT * FROM memory_hub_members ORDER BY environment`,
            leases: yield* sql`SELECT * FROM memory_hub_leases ORDER BY memory_id`,
            receipts: yield* sql`SELECT * FROM memory_compact_receipts ORDER BY operation_id`,
            guards: yield* sql`SELECT * FROM memory_import_keys ORDER BY key_kind,key`,
            counters:
              yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
          };
        });
        const before = yield* snapshot;
        const failure = yield* store.transact(publish).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MemoryCapacityError");
        if (failure._tag === "MemoryCapacityError") {
          assert.strictEqual(failure.dimension, "checkpoint_staging");
          assert.strictEqual(failure.current, M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES + 1);
        }
        assert.deepStrictEqual(yield* snapshot, before);
        yield* sql`UPDATE memory_quota_counters SET value=${privateBytes} WHERE space='_hub_global' AND dimension='import_staging' AND scope_key=''`;
        const accepted = yield* store.transact(publish);
        assert.strictEqual(
          accepted.stagingBytes + privateBytes,
          M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
        );
        assert.strictEqual(accepted.liveHandles, 2);
        const finalBytes = yield* sql<{
          bytes: number;
          publications: number;
        }>`SELECT sum(length(CAST(metadata_json AS BLOB))) AS bytes,count(DISTINCT checkpoint_id) AS publications FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot'`;
        assert.strictEqual(finalBytes[0]!.publications, 2);
        assert.strictEqual(accepted.publishedPinnedBytes, finalBytes[0]!.bytes);
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "daily scheduling survives service reconstruction and preserves nonexpired history",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* push();
        const compactor = yield* Compactor.MemoryCompactor;
        const first = yield* compactor.compactIfNeeded(principal());
        assert.strictEqual(first.compaction.removedRows, 0);
        const restarted = yield* Compactor.make.pipe(
          Effect.provideService(Hub.MemoryHubConfiguration, {
            read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
          }),
        );
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS - 1);
        assert.strictEqual(
          (yield* restarted.compactIfNeeded(principal())).checkpointId,
          first.checkpointId,
        );
        yield* TestClock.adjust(1);
        assert.notStrictEqual(
          (yield* restarted.compactIfNeeded(principal())).checkpointId,
          first.checkpointId,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual(
          (yield* sql<{ count: number }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!
            .count,
          1,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("row and byte triggers publish before the daily deadline", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      let first = yield* compactor.compact(principal());
      const sql = yield* SqlClient.SqlClient;
      // Denormalized tail bytes are a measurement fixture, not fabricated floor/publication.
      const padded = " ".repeat(M.MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES);
      const receipt = yield* push();
      yield* sql`UPDATE memory_hub_operations SET entry_json=entry_json || ${padded} WHERE operation_id=${receipt.receipts[0]!.operationId}`;
      const byBytes = yield* compactor.compactIfNeeded(principal());
      assert.notStrictEqual(byBytes.checkpointId, first.checkpointId);
      first = byBytes;
      // Every synthetic row is a body-free tail fixture; checkpoint state is built from real canonical writes.
      yield* sql`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<${M.MEMORY_CHECKPOINT_TRIGGER_TAIL_ROWS}) INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) SELECT ${space},'tail-'||n,${memoryId},${hubEnv},${"c".repeat(64)},'{}',0 FROM rows`;
      assert.notStrictEqual(
        (yield* compactor.compactIfNeeded(principal())).checkpointId,
        first.checkpointId,
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "start follows the durable daily deadline after a signal and interrupts its scoped workers",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* push();
        const store = yield* Store.MemoryStore;
        const activity = yield* Hub.MemoryHubActivity;
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        const mainId = yield* Effect.withFiberSucceed((fiber) => fiber.id);
        const workers = yield* Ref.make(new Map<number, Fiber.Fiber<unknown, unknown>>());
        const completed = yield* Ref.make(0);
        const signaled = yield* Deferred.make<void>();
        const daily = yield* Deferred.make<void>();
        const observed = Store.MemoryStore.of({
          ...store,
          changes: (spaceId) =>
            store
              .changes(spaceId)
              .pipe(
                Effect.map((stream) =>
                  Stream.unwrap(
                    Effect.withFiber((fiber) =>
                      Ref.update(workers, (all) => new Map(all).set(fiber.id, fiber)).pipe(
                        Effect.as(stream),
                      ),
                    ),
                  ),
                ),
              ),
          readHubRetentionTx: (spaceId) =>
            Effect.withFiber((fiber) =>
              Ref.update(workers, (all) =>
                fiber.id === mainId ? all : new Map(all).set(fiber.id, fiber),
              ).pipe(Effect.andThen(store.readHubRetentionTx(spaceId))),
            ),
          compactEligibleHistoryTx: (input) =>
            store.compactEligibleHistoryTx(input).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  const count = yield* Ref.updateAndGet(completed, (n) => n + 1);
                  if (count === 2) yield* Deferred.succeed(signaled, undefined);
                  if (count === 3) yield* Deferred.succeed(daily, undefined);
                }),
              ),
            ),
        });
        const compactor = yield* Compactor.make.pipe(
          Effect.provideService(Store.MemoryStore, observed),
          Effect.provideService(Hub.MemoryHubConfiguration, {
            read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
          }),
        );
        yield* compactor.start(principal()).pipe(Effect.provideService(Scope.Scope, scope));
        const startedAt = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust(3600000);
        const sql = yield* SqlClient.SqlClient;
        const padded = " ".repeat(M.MEMORY_CHECKPOINT_TRIGGER_TAIL_BYTES);
        yield* sql`UPDATE memory_hub_operations SET entry_json=entry_json || ${padded} WHERE space=${space}`;
        yield* activity.notify;
        yield* Deferred.await(signaled);
        const signaledRun = yield* store.transact(store.readHubRetentionTx(space));
        assert.strictEqual(Date.parse(signaledRun.compaction.lastRunAtUtc!), startedAt + 3600000);
        yield* sql`UPDATE memory_hub_operations SET entry_json=rtrim(entry_json) WHERE space=${space}`;
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS - 1);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).checkpointId,
          signaledRun.checkpointId,
        );
        yield* TestClock.adjust(1);
        // Read the committed milestone at the deadline, so a missing daily run
        // fails immediately instead of relying on the test runner's timeout.
        assert.strictEqual(
          Date.parse(
            (yield* store.transact(store.readHubRetentionTx(space))).compaction.lastRunAtUtc!,
          ),
          startedAt + 3600000 + M.MEMORY_CHECKPOINT_INTERVAL_MS,
        );
        yield* Deferred.await(daily);
        const dailyRun = yield* store.transact(store.readHubRetentionTx(space));
        assert.strictEqual(
          Date.parse(dailyRun.compaction.lastRunAtUtc!),
          startedAt + 3600000 + M.MEMORY_CHECKPOINT_INTERVAL_MS,
        );
        assert.notStrictEqual(dailyRun.checkpointId, signaledRun.checkpointId);
        yield* Scope.close(scope, Exit.void);
        const captured = yield* Ref.get(workers);
        // Changes, admissions and timer all belong to the application Scope.
        assert.strictEqual(captured.size, 3);
        for (const fiber of captured.values()) {
          const exit = yield* Fiber.await(fiber);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterrupts(exit.cause));
        }
        yield* activity.notify;
        yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS);
        assert.strictEqual(
          (yield* store.transact(store.readHubRetentionTx(space))).checkpointId,
          dailyRun.checkpointId,
        );
        assert.strictEqual(yield* Ref.get(completed), 3);
      }).pipe(Effect.scoped, checkUsage, Effect.provide(live)),
  );
  it.effect("members cannot run hub compaction or floor publication", () =>
    Effect.gen(function* () {
      yield* seed;
      const compactor = yield* Compactor.MemoryCompactor;
      assert.strictEqual(
        (yield* compactor.compact(principal(memberEnv)).pipe(Effect.flip))._tag,
        "MemoryHubForbiddenError",
      );
      const store = yield* Store.MemoryStore;
      assert.isNull((yield* store.transact(store.readHubRetentionTx(space))).checkpointId);
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

it.effect(
  "M-R5-1 toolkit replay survives actual event and superseded revision compaction and forget",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* Service.MemoryService;
      const store = yield* Store.MemoryStore;
      const hub = yield* Hub.MemoryHubService;
      const compactor = yield* Compactor.MemoryCompactor;
      const input = { ...McpFixture.upsert(96001), memorySpaceId: space };
      const invocation = { ...McpFixture.scope(), environmentId: hubEnv };
      const first = yield* McpFixture.call("memory_upsert", input, invocation);
      assert.isNotTrue(first.result.isError);
      const pending = yield* decodeReplayReceipt(first.body);
      const ack = Effect.fnUntraced(function* (operationId: M.MemoryOperationId) {
        const workId = `sync:${space}:${operationId}`;
        const op = yield* store.readWorkOperation(workId);
        assert.isDefined(op);
        const response = yield* hub.push(
          { protocolVersion: 1, memorySpaceId: space, environmentId: hubEnv, operations: [op!] },
          principal(),
        );
        yield* store.acknowledgeOutbox(workId, response.receipts[0]!);
      });
      yield* ack(input.operationId);
      const counts = sql`SELECT (SELECT count(*) FROM memory_events) AS events,(SELECT count(*) FROM memory_payloads) AS payloads,(SELECT count(*) FROM memory_outbox) AS outbox`;
      const replay = Effect.gen(function* () {
        const before = yield* counts;
        const response = yield* McpFixture.call("memory_upsert", input, invocation);
        assert.isNotTrue(response.result.isError);
        const receipt = yield* decodeReplayReceipt(response.body, {
          onExcessProperty: "error",
        });
        assert.isFalse(receipt.pendingSync);
        assert.strictEqual(receipt.revisionId, pending.revisionId);
        assert.strictEqual(
          (
            (yield* McpFixture.call(
              "memory_upsert",
              { ...input, payload: { ...input.payload, text: "changed" } },
              invocation,
            )).body as { code: string }
          ).code,
          "operation_id_reused",
        );
        const otherCaller = {
          ...invocation,
          client: undefined,
          thread: {
            threadId: M.ThreadId.make("changed-caller"),
            providerSessionId: "synthetic",
            providerInstanceId: M.ProviderInstanceId.make("codex"),
          },
        };
        assert.strictEqual(
          ((yield* McpFixture.call("memory_upsert", input, otherCaller)).body as { code: string })
            .code,
          "operation_id_reused",
        );
        assert.deepStrictEqual(yield* counts, before);
      });
      yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
      yield* compactor.compact(principal());
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_events WHERE operation_id=${input.operationId}`,
        0,
      );
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_revisions WHERE operation_id=${input.operationId}`,
        1,
      );
      yield* replay;
      const updated = {
        ...input,
        operationId: M.MemoryOperationId.make(id(96002)),
        expectedHeads: [pending.revisionId!],
        payload: { ...input.payload, text: "replacement" },
      };
      yield* service.upsert(updated, Effect.void);
      yield* ack(updated.operationId);
      yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
      yield* compactor.compact(principal());
      // The old payload is collected first, then its now-unreferenced revision.
      yield* compactor.compact(principal());
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_revisions WHERE operation_id=${input.operationId}`,
        0,
      );
      yield* replay;
      const forgotten = {
        memorySpaceId: space,
        memoryId: input.memoryId,
        operationId: M.MemoryOperationId.make(id(96003)),
        expectedHeads: (yield* store.loadAggregate(space, input.memoryId)).heads,
      };
      yield* service.forget(forgotten, Effect.void);
      yield* ack(forgotten.operationId);
      yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
      yield* compactor.compact(principal());
      yield* replay;
      assert.lengthOf(
        yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${input.memoryId}`,
        0,
      );
    }).pipe(
      Effect.provide(
        McpHttpServer.layerMemoryToolkit.pipe(
          Layer.provide(McpAccess.layerPermissionProfilesOff),
          Layer.provideMerge(live),
          Layer.provide(Layer.mock(Sync.MemorySyncService)({})),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(McpAccess.liveThreadsLayer),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
