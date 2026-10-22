import * as Settings from "../serverSettings.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import migration from "../persistence/Migrations/076_Memory.ts";
import hubMigration from "../persistence/Migrations/077_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/080_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/081_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/093_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/082_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/083_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/084_MemoryRevertResults.ts";
import searchMigration from "../persistence/Migrations/078_MemorySearchCounters.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Snapshot from "./MemorySnapshot.ts";
import { scanMemoryValue, MEMORY_SCANNER_POLICY_VERSION } from "./MemorySecretScanner.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const hubId = M.EnvironmentId.make("synthetic-hub");
const memberId = M.EnvironmentId.make("synthetic-member");
const at = Date.parse("2026-10-15T00:00:00.000Z");
const thread = { environmentId: memberId, threadId: M.ThreadId.make("synthetic-thread") };
const input = (n: number, deps: readonly M.MemoryRevisionId[] = []): M.MemoryUpsertInput => ({
  memorySpaceId: space,
  memoryId: M.MemoryId.make(id(n)),
  operationId: M.MemoryOperationId.make(id(n + 1000)),
  expectedHeads: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  payload: { text: `synthetic lineage ${n}`, evidence: [], derivedFromMemoryRevisions: deps },
  baseBoundary: null,
});
const makeEnvironment = Effect.fnUntraced(function* (environmentId: M.EnvironmentId) {
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
  const core = Layer.merge(Service.layer, Maintenance.layer).pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provideMerge(
      Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(database)))),
    ),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  );
  const live = Snapshot.layer.pipe(
    Layer.provideMerge(core),
    Layer.provide(
      Layer.mock(Sync.MemorySyncService)({
        readLocalReadiness: () =>
          Effect.succeed({ memorySpaceId: space, bootstrap: "ready" as const }),
      }),
    ),
    Layer.provide(
      Layer.mock(Projection.ProjectionStoreV2)({
        getThreadShell: (requested) =>
          Effect.succeed({
            id: requested,
            projectId: M.ProjectId.make("synthetic-project"),
            activeRunId: M.RunId.make("synthetic-run"),
            activityRunStatus: "running",
          } as M.OrchestrationV2ThreadShell),
      }),
    ),
  );
  const context = yield* Layer.build(live);
  const store = Context.get(context, Store.MemoryStore);
  const service = Context.get(context, Service.MemoryService);
  const sql = Context.get(context, SqlClient.SqlClient);
  yield* sql`CREATE TABLE orchestration_events(application_event_version INTEGER,aggregate_kind TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT)`;
  yield* sql`CREATE TABLE projection_projects(project_id TEXT,workspace_root TEXT,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES ('synthetic-project','/synthetic',NULL)`;
  return {
    store,
    service,
    sql,
    maintenance: Context.get(context, Maintenance.MemoryFtsMaintenance),
    snapshot: Context.get(context, Snapshot.MemorySnapshot),
  };
});
const authority = (environmentId = memberId, now = at): Store.HubAuthority => ({
  principal: { memorySpaceId: space, environmentId, credentialVersion: 1, scopes: ["memory:sync"] },
  now: Effect.succeed(now),
  reauthorize: Effect.void,
});
const enroll = (sql: SqlClient.SqlClient) =>
  sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${memberId},${"a".repeat(64)},1,'active',0)`;
const operation = (store: Store.MemoryStore["Service"], value: M.MemoryUpsertInput) =>
  store.readWorkOperation(`sync:${space}:${value.operationId}`).pipe(
    Effect.map((op) => {
      if (!op || op.kind !== "upsert") throw new Error("fixture operation");
      return op;
    }),
  );

describe("r4 authoritative lineage", () => {
  it.effect(
    "H-R3-2 normalizes direct edges and refuses unavailable payloads and 100 to 101 closure",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, store, sql } = yield* makeEnvironment(memberId);
          yield* service.upsert(input(10), Effect.void);
          const a = (yield* store.loadAggregate(space, input(10).memoryId)).heads[0]!;
          yield* service.upsert(input(11, [a]), Effect.void);
          const b = (yield* store.loadAggregate(space, input(11).memoryId)).heads[0]!;
          yield* service.upsert(input(12, [b]), Effect.void);
          const d = yield* operation(store, input(12));
          assert.sameMembers([...d.payload.derivedFromMemoryRevisions], [a, b]);
          // The direct API cannot certify a missing dependency body, even if identity remains.
          yield* sql`DELETE FROM memory_payloads WHERE payload_ref=${b}`;
          const missing = yield* service.upsert(input(13, [b]), Effect.void).pipe(Effect.flip);
          assert.strictEqual(missing._tag, "MemoryStoreConflict");
          if (missing._tag === "MemoryStoreConflict")
            assert.strictEqual(missing.code, "source_invalidated");
          assert.isUndefined(yield* store.receipt(space, input(13).operationId));
          const roots: M.MemoryRevisionId[] = [];
          for (let n = 100; n < 200; n++) {
            yield* service.upsert(input(n), Effect.void);
            roots.push((yield* store.loadAggregate(space, input(n).memoryId)).heads[0]!);
          }
          yield* service.upsert(input(200, roots), Effect.void);
          const hundred = (yield* store.loadAggregate(space, input(200).memoryId)).heads[0]!;
          const overflow = yield* service
            .upsert(input(201, [hundred]), Effect.void)
            .pipe(Effect.flip);
          assert.strictEqual(overflow._tag, "MemoryStoreConflict");
          if (overflow._tag === "MemoryStoreConflict")
            assert.strictEqual(overflow.code, "invalid_output");
          assert.isUndefined(yield* store.receipt(space, input(201).operationId));
        }),
      ),
  );
  it.effect(
    "H-R3-1 two stores reject a late summary after hub identity GC, terminate ACK, and bootstrap without it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(at);
          const h = yield* makeEnvironment(hubId);
          const e = yield* makeEnvironment(memberId);
          yield* enroll(h.sql);
          yield* enroll(e.sql);
          const push = Effect.fnUntraced(function* (value: M.MemoryUpsertInput) {
            yield* e.service.upsert(value, Effect.void);
            const op = yield* operation(e.store, value);
            const receipt = yield* h.service.admitHubOperation({
              authority: authority(),
              operation: op,
            });
            yield* e.service.settleHubAcknowledgement({
              memorySpaceId: space,
              hubEnvironmentId: hubId,
              localEnvironmentId: memberId,
              workId: `sync:${space}:${op.operationId}`,
              operation: { operationId: op.operationId, operationDigest: receipt.operationDigest },
              receipt,
              reauthorize: Effect.void,
            });
            // Settle the actual scanner work created by replica admission before indexing.
            yield* e.store.recoverDeferred(MEMORY_SCANNER_POLICY_VERSION, at);
            for (const target of yield* e.store.readDeferred(at, 100)) {
              if (target.kind !== "scanner" || target.memoryId !== op.memoryId) continue;
              assert.isTrue(
                yield* e.store.claimDeferred(target, "synthetic-scanner", at, at + 600000),
              );
              const chunk = yield* e.store.readScannerChunk(target);
              assert.strictEqual(scanMemoryValue({ payloads: chunk.payloads }).kind, "allowed");
              assert.isNull(chunk.nextCursor);
              assert.isTrue(
                yield* e.store.finishOwnedDeferred(target, "synthetic-scanner", at + 600000, {
                  now: at,
                  scannerPolicyVersion: MEMORY_SCANNER_POLICY_VERSION,
                }),
              );
            }
            const current = yield* e.store.loadAggregate(space, op.memoryId);
            assert.isTrue(
              yield* e.maintenance.repair({
                memorySpaceId: space,
                memoryId: op.memoryId,
                revisionId: op.revision.revisionId,
                generation: current.generation,
              }),
            );
            return op;
          });
          const a = yield* push(input(20));
          const policy = { grant: "read" as const, policyEpoch: 1 };
          assert.isDefined(
            yield* e.snapshot.forThread(thread.threadId, policy, Effect.succeed(policy)),
          );
          yield* push({
            ...input(20),
            operationId: M.MemoryOperationId.make(id(2021)),
            expectedHeads: [a.revision.revisionId],
          });
          const gcAt = at + 2 * M.MEMORY_LOG_RETENTION_MS;
          for (const env of [h]) {
            yield* env.sql`UPDATE memory_payloads SET purge_eligible_after=0 WHERE payload_ref=${a.revision.payloadRef}`;
            const handle = yield* env.store.transact(
              env.store.prepareHubCheckpointTx({
                authority: authority(memberId, gcAt),
                checkpointId: "r4-gc",
                snapshotToken: "r4-gc",
                hubEnvironmentId: hubId,
              }),
            );
            yield* env.store.transact(
              env.store.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: "r4-gc",
                expectedFloor: 0,
                nextFloor: handle.checkpointSequence,
                now: gcAt,
              }),
            );
            for (let n = 0; n < 3; n++)
              yield* env.store.transact(
                env.store.compactEligibleHistoryTx({
                  memorySpaceId: space,
                  expectedFloor: handle.checkpointSequence,
                  now: gcAt + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
                  limit: 100,
                }),
              );
          }
          assert.lengthOf(
            yield* h.sql`SELECT 1 FROM memory_revisions WHERE revision_id=${a.revision.revisionId}`,
            0,
          );
          assert.lengthOf(
            yield* e.sql`SELECT 1 FROM memory_revisions WHERE revision_id=${a.revision.revisionId}`,
            1,
          );
          // A tracked thread write uses the same transaction and union as the MCP entry point.
          const s: M.MemoryUpsertInput = { ...input(22), scope: { kind: "thread", thread } };
          yield* e.service.upsert(s, Effect.void, thread);
          const summary = yield* operation(e.store, s);
          assert.deepStrictEqual(summary.payload.derivedFromMemoryRevisions, [
            a.revision.revisionId,
          ]);
          const refusal = yield* h.service.admitHubOperation({
            authority: authority(memberId, gcAt),
            operation: summary,
          });
          assert.strictEqual(refusal.outcome, "rejected");
          assert.strictEqual(refusal.failureCode, "source_invalidated");
          const ack = {
            memorySpaceId: space,
            hubEnvironmentId: hubId,
            localEnvironmentId: memberId,
            workId: `sync:${space}:${summary.operationId}`,
            operation: {
              operationId: summary.operationId,
              operationDigest: refusal.operationDigest,
            },
            receipt: refusal,
            reauthorize: Effect.void,
          };
          yield* e.service.settleHubAcknowledgement(ack);
          yield* e.service.settleHubAcknowledgement(ack);
          assert.strictEqual((yield* e.store.readWork(ack.workId))?.status, "failed");
          assert.lengthOf(yield* e.store.readEligibleOutbox(space, gcAt, 100), 0);
          assert.lengthOf(
            yield* e.sql`SELECT 1 FROM memory_payloads WHERE memory_id=${s.memoryId}`,
            1,
          );
          assert.deepStrictEqual(
            yield* e.sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='derived_admission_rejected'`,
            [{ value: 1 }],
          );
          const forget = yield* h.service.forget(
            {
              memorySpaceId: space,
              memoryId: a.memoryId,
              operationId: M.MemoryOperationId.make(id(2023)),
              expectedHeads: (yield* h.store.loadAggregate(space, a.memoryId)).heads,
            },
            Effect.void,
          );
          assert.strictEqual(forget.receipt.outcome, "deleted");
          yield* h.sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubId},${"b".repeat(64)},1,'active',0)`;
          const hubForget = yield* h.store.readWorkOperation(
            `sync:${space}:${forget.receipt.operationId}`,
          );
          assert.isDefined(hubForget);
          yield* h.service.admitHubOperation({
            authority: authority(hubId, gcAt),
            operation: hubForget!,
          });
          // A local-only refused summary remains purgeable through the member's pin.
          yield* e.service.forget(
            {
              memorySpaceId: space,
              memoryId: a.memoryId,
              operationId: M.MemoryOperationId.make(id(2024)),
              expectedHeads: (yield* e.store.loadAggregate(space, a.memoryId)).heads,
            },
            Effect.void,
          );
          assert.lengthOf(
            yield* e.sql`SELECT 1 FROM memory_payloads WHERE memory_id=${s.memoryId}`,
            0,
          );
          const fresh = yield* makeEnvironment(M.EnvironmentId.make("synthetic-bootstrap"));
          const handle = yield* h.store.transact(
            h.store.prepareHubCheckpointTx({
              authority: authority(memberId, gcAt + 1),
              checkpointId: "r4-after",
              snapshotToken: "r4-after",
              hubEnvironmentId: hubId,
            }),
          );
          const stage = {
            memorySpaceId: space,
            hubEnvironmentId: hubId,
            checkpointId: handle.checkpointId,
            expectedSnapshotToken: "r4-after",
            expectedCheckpointSequence: handle.checkpointSequence,
          };
          yield* fresh.store.transact(
            fresh.store.advanceBootstrapTx({
              memorySpaceId: space,
              hubEnvironmentId: hubId,
              expectedState: "unbound",
              nextState: "staging",
              checkpointId: handle.checkpointId,
              snapshotToken: "r4-after",
              checkpointSequence: handle.checkpointSequence,
              nextCursor: null,
            }),
          );
          let cursor: string | null = null;
          let pageCount = 0;
          do {
            const page: M.MemoryHubCheckpointPage = yield* h.store.transact(
              h.store.readHubCheckpointPageTx({
                authority: authority(memberId, gcAt + 1),
                snapshotToken: "r4-after",
                cursor,
              }),
            );
            yield* fresh.store.installCheckpointPage({ ...stage, page });
            pageCount++;
            cursor = page.nextCursor;
          } while (cursor);
          yield* fresh.store.completeCheckpoint({ ...stage, pageCount });
          for (const env of [h, fresh]) {
            assert.lengthOf(
              yield* env.sql`SELECT 1 FROM memory_payloads WHERE memory_id=${s.memoryId}`,
              0,
            );
            const results = yield* env.service.search(
              { memorySpaceId: space, query: "synthetic", limit: 100, mode: "fts" },
              Effect.void,
            );
            assert.isFalse(results.items.some((i) => i.memoryId === s.memoryId));
          }
        }),
      ),
  );
});
