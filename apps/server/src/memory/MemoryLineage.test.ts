import { makeMemorySaveSuggestions } from "./MemorySaveSuggestions.ts";
import { suggestionForgetGeneration } from "./store/SaveSuggestions.ts";
import { appOwnedTaskResultEvents } from "./threadProvenance.testkit.ts";
import * as Settings from "../serverSettings.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import migration from "../persistence/Migrations/098_Memory.ts";
import hubMigration from "./testkit/MemoryHubTestMigration.ts";
import lineageMigration from "../persistence/Migrations/102_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/103_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/115_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/104_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/105_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/106_MemoryRevertResults.ts";
import searchMigration from "../persistence/Migrations/100_MemorySearchCounters.ts";
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
const makeEnvironment = Effect.fnUntraced(function* (
  environmentId: M.EnvironmentId,
  serviceLayer: typeof Service.layer = Service.layer,
) {
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
  const core = Layer.merge(serviceLayer, Maintenance.layer).pipe(
    Layer.provideMerge(
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
        getRunMessage: () => Effect.sync(() => undefined),
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
  yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,deleted_at TEXT,archived_at TEXT,updated_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs(run_id TEXT,thread_id TEXT,ordinal INTEGER,status TEXT,payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,role TEXT,payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_turn_items(thread_id TEXT,run_id TEXT,type TEXT,status TEXT)`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${thread.threadId},'synthetic-project',NULL,NULL,'2026-01-01')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('synthetic-run',${thread.threadId},1,'running','{}')`;
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
  it.effect("pressure compaction preserves a pending forget intent and its sync work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(at);
        const h = yield* makeEnvironment(hubId);
        yield* h.sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubId},${"a".repeat(64)},1,'active',0)`;
        const value = input(25);
        yield* h.service.upsert(value, Effect.void);
        const op = yield* operation(h.store, value);
        const receipt = yield* h.service.admitHubOperation({
          authority: authority(hubId),
          operation: op,
        });
        yield* h.service.settleHubAcknowledgement({
          memorySpaceId: space,
          hubEnvironmentId: hubId,
          localEnvironmentId: hubId,
          workId: `sync:${space}:${op.operationId}`,
          operation: { operationId: op.operationId, operationDigest: receipt.operationDigest },
          receipt,
          reauthorize: Effect.void,
        });
        const checkpoint = yield* h.store.transact(
          h.store.prepareHubProducerCheckpointTx({
            authority: authority(hubId),
            checkpointId: "forget-pressure",
            hubEnvironmentId: hubId,
          }),
        );
        yield* h.store.transact(
          h.store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: checkpoint.checkpointId,
            expectedFloor: 0,
            nextFloor: checkpoint.checkpointSequence,
            now: at,
          }),
        );
        const forgetId = M.MemoryOperationId.make(id(9025));
        yield* h.service.forget(
          {
            memorySpaceId: space,
            memoryId: value.memoryId,
            operationId: forgetId,
            expectedHeads: [op.revision.revisionId],
          },
          Effect.void,
        );
        yield* h.sql`INSERT INTO memory_pending_forget_intents(space,memory_id,operation_id,requested_at_utc,attempts,submission_state) VALUES (${space},${value.memoryId},${forgetId},'2026-10-15T00:00:00.000Z',0,'unsubmitted')`;
        yield* h.store.transact(
          h.store.compactEligibleHistoryTx({
            memorySpaceId: space,
            expectedFloor: checkpoint.checkpointSequence,
            now: at + 86_400_001,
            limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
            pressure: true,
          }),
        );
        assert.lengthOf(
          yield* h.sql`SELECT 1 FROM memory_pending_forget_intents WHERE operation_id=${forgetId}`,
          1,
        );
        assert.lengthOf(
          yield* h.sql`SELECT 1 FROM memory_outbox WHERE id=${`sync:${space}:${forgetId}`}`,
          1,
        );
      }),
    ),
  );
  it.effect(
    "pressure removes covered events while keeping completed sync, payload and receipt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(at);
          const h = yield* makeEnvironment(hubId);
          yield* h.sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubId},${"a".repeat(64)},1,'active',0)`;
          const value = input(21);
          yield* h.service.upsert(value, Effect.void);
          const op = yield* operation(h.store, value);
          const receipt = yield* h.service.admitHubOperation({
            authority: authority(hubId),
            operation: op,
          });
          const workId = `sync:${space}:${op.operationId}`;
          yield* h.service.settleHubAcknowledgement({
            memorySpaceId: space,
            hubEnvironmentId: hubId,
            localEnvironmentId: hubId,
            workId,
            operation: { operationId: op.operationId, operationDigest: receipt.operationDigest },
            receipt,
            reauthorize: Effect.void,
          });
          const checkpoint = yield* h.store.transact(
            h.store.prepareHubProducerCheckpointTx({
              authority: authority(hubId),
              checkpointId: "pressure-test",
              hubEnvironmentId: hubId,
            }),
          );
          yield* h.store.transact(
            h.store.publishCheckpointAndFloorTx({
              memorySpaceId: space,
              checkpointId: checkpoint.checkpointId,
              expectedFloor: 0,
              nextFloor: checkpoint.checkpointSequence,
              now: at,
            }),
          );
          const now = at + 86_400_001;
          const status = yield* h.store.transact(
            h.store.compactEligibleHistoryTx({
              memorySpaceId: space,
              expectedFloor: checkpoint.checkpointSequence,
              now,
              limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
              pressure: true,
            }),
          );
          assert.isAbove(status.removedRows, 0);
          assert.lengthOf(yield* h.sql`SELECT 1 FROM memory_outbox WHERE id=${workId}`, 1);
          assert.lengthOf(
            yield* h.sql`SELECT 1 FROM memory_events WHERE operation_id=${op.operationId}`,
            0,
          );
          assert.lengthOf(
            yield* h.sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${op.revision.payloadRef}`,
            1,
          );
          assert.isDefined(yield* h.store.receipt(space, op.operationId));
        }),
      ),
  );
  it.effect("a repeated acknowledgement remains idempotent after pressure compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(at);
        const h = yield* makeEnvironment(hubId);
        const e = h;
        yield* h.sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubId},${"a".repeat(64)},1,'active',0)`;
        const value = input(10);
        yield* e.service.upsert(value, Effect.void);
        const op = yield* operation(e.store, value);
        const receipt = yield* h.service.admitHubOperation({
          authority: authority(hubId),
          operation: op,
        });
        const ack = {
          memorySpaceId: space,
          hubEnvironmentId: hubId,
          localEnvironmentId: hubId,
          workId: `sync:${space}:${op.operationId}`,
          operation: { operationId: op.operationId, operationDigest: receipt.operationDigest },
          receipt,
          reauthorize: Effect.void,
        };
        yield* e.service.settleHubAcknowledgement(ack);
        const checkpoint = yield* h.store.transact(
          h.store.prepareHubProducerCheckpointTx({
            authority: authority(hubId),
            checkpointId: "ack-pressure",
            hubEnvironmentId: hubId,
          }),
        );
        yield* h.store.transact(
          h.store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: checkpoint.checkpointId,
            expectedFloor: 0,
            nextFloor: checkpoint.checkpointSequence,
            now: at,
          }),
        );
        yield* h.store.transact(
          h.store.compactEligibleHistoryTx({
            memorySpaceId: space,
            expectedFloor: checkpoint.checkpointSequence,
            now: at + 86_400_001,
            limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
            pressure: true,
          }),
        );
        assert.lengthOf(yield* e.sql`SELECT 1 FROM memory_outbox WHERE id=${ack.workId}`, 1);
        const repeated = yield* e.service.settleHubAcknowledgement(ack);
        assert.isFalse(repeated.incorporated);
      }),
    ),
  );
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
          assert.strictEqual(overflow._tag, "MemoryCapacityError");
          if (overflow._tag === "MemoryCapacityError") {
            assert.strictEqual(overflow.dimension, "dependencies");
            assert.strictEqual(overflow.current, 101);
            assert.strictEqual(overflow.limit, 100);
          }
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
          const policy = {
            grant: "read" as const,
            policyEpoch: 1,
            finalAuthority: Effect.succeed(true),
          };
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

it.effect(
  "bounds child-result history while preserving lineage collected before the scan limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { store, sql } = yield* makeEnvironment(memberId);
        const early = M.ThreadId.make("synthetic-early-child");
        const late = M.ThreadId.make("synthetic-late-child");
        const earlyRevision = M.MemoryRevisionId.make(id(9901));
        const lateRevision = M.MemoryRevisionId.make(id(9902));
        for (const [child, revision] of [
          [early, earlyRevision],
          [late, lateRevision],
        ] as const)
          yield* store.appendThreadLineage({ ...thread, threadId: child }, space, [revision]);
        const insertChild = Effect.fn("test.insertChild")(function* (child: M.ThreadId) {
          for (const event of appOwnedTaskResultEvents(thread.threadId, child))
            yield* sql`INSERT INTO orchestration_events VALUES (2,'thread',${event.streamId},${event.type},${event.payloadJson})`;
        });
        yield* insertChild(early);
        const transfer = JSON.stringify({
          type: "subagent_result",
          targetThreadId: thread.threadId,
          sourceThreadId: "synthetic-unlinked-child",
        });
        yield* sql`INSERT INTO orchestration_events VALUES (2,'thread',${thread.threadId},'context-transfer.created',${transfer})`;
        yield* sql`WITH RECURSIVE copies(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM copies WHERE n<1000)
      INSERT INTO orchestration_events SELECT t.* FROM orchestration_events t, copies
      WHERE t.event_type='context-transfer.created' AND json_extract(t.payload_json,'$.sourceThreadId')=${early}`;
        yield* insertChild(late);
        const lineage = yield* store.readThreadLineage(thread, space);
        assert.deepStrictEqual(lineage, { state: "unknown", revisions: [earlyRevision] });
      }),
    ),
);

it.effect(
  "floor-2 remember and suggestion acceptance settle with a pinned, body-pruned dependency",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(at);
        const { service, store, sql } = yield* makeEnvironment(memberId);
        yield* enroll(sql);
        yield* store.transact(store.learnHubFloor(space, at));
        yield* sql`ALTER TABLE orchestration_events ADD COLUMN event_id TEXT`;
        yield* sql`ALTER TABLE orchestration_events ADD COLUMN sequence INTEGER`;
        const savedSource = input(601);
        const admit = (op: M.MemoryOperation) =>
          service.admitHubOperation({ authority: authority(memberId, at), operation: op });
        yield* service.upsert(savedSource, Effect.void);
        const oldest = yield* operation(store, savedSource);
        assert.propertyVal(yield* admit(oldest), "outcome", "accepted");
        yield* store.appendThreadLineage(thread, space, [oldest.revision.revisionId]);
        const edit = {
          ...savedSource,
          operationId: M.MemoryOperationId.make(id(99001)),
          expectedHeads: [oldest.revision.revisionId],
          payload: { ...savedSource.payload, text: "synthetic replacement" },
        };
        yield* service.upsert(edit, Effect.void);
        const newest = yield* operation(store, edit);
        assert.propertyVal(yield* admit(newest), "outcome", "accepted");
        const gcAt = at + 2 * M.MEMORY_LOG_RETENTION_MS;
        const checkpoint = yield* store.transact(
          store.prepareHubCheckpointTx({
            authority: authority(memberId, gcAt),
            checkpointId: "pinned-source",
            snapshotToken: "pinned-source",
            hubEnvironmentId: memberId,
          }),
        );
        yield* store.transact(
          store.publishCheckpointAndFloorTx({
            memorySpaceId: space,
            checkpointId: "pinned-source",
            expectedFloor: 0,
            nextFloor: checkpoint.checkpointSequence,
            now: gcAt,
          }),
        );
        yield* store.transact(
          store.compactEligibleHistoryTx({
            memorySpaceId: space,
            expectedFloor: checkpoint.checkpointSequence,
            now: gcAt + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
            limit: 100,
          }),
        );
        const history = yield* store.loadAggregate(space, oldest.memoryId, {
          revisionIds: [oldest.revision.revisionId],
        });
        assert.isNull(
          history.revisions.find((pair) => pair.revision.revisionId === oldest.revision.revisionId)
            ?.payload,
        );

        const unknown = { ...thread, threadId: M.ThreadId.make("synthetic-unknown") };
        const words = "Synthetic words from the person";
        yield* sql`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN thread_id TEXT`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${unknown.threadId},'synthetic-project',NULL,NULL,'2026-01-01')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES
          ('unknown-run',${unknown.threadId},1,'running','{"userMessageId":"person-root"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES
          ('person-root','user',${JSON.stringify({
            threadId: unknown.threadId,
            runId: "unknown-run",
            id: "person-root",
            role: "user",
            nodeId: null,
            text: words,
            attachments: [],
            streaming: false,
            createdAt: newest.revision.createdAtUtc,
            updatedAt: newest.revision.createdAtUtc,
            createdBy: "user",
            creationSource: "web",
            ingress: "person",
          })},${unknown.threadId})`;
        yield* store.appendThreadLineage(unknown, space, [oldest.revision.revisionId]);
        yield* sql`UPDATE memory_thread_lineages SET state='unknown' WHERE thread_id=${unknown.threadId}`;
        const exact = yield* service.remember(
          { memorySpaceId: space, scope: "user", text: words },
          Effect.void,
          unknown,
        );
        const exactOp = yield* store.readWorkOperation(
          `sync:${space}:${exact.receipt.operationId}`,
        );
        if (!exactOp || exactOp.kind !== "upsert")
          throw new Error("Expected a staged exact-word save");
        assert.deepStrictEqual(exactOp.payload.derivedFromMemoryRevisions, [
          oldest.revision.revisionId,
        ]);
        assert.propertyVal(yield* admit(exactOp), "outcome", "accepted");
        assert.propertyVal(exactOp.revision.provenance, "unverified", true);

        const revisions = [oldest.revision.revisionId];
        for (let n = 700; n < 800; n++) {
          const source = input(n);
          yield* service.upsert(source, Effect.void);
          revisions.push((yield* operation(store, source)).revision.revisionId);
        }
        yield* store.appendThreadLineage(thread, space, revisions);
        const remembered = yield* service.remember(
          { memorySpaceId: space, scope: "user", text: "synthetic remembered text" },
          Effect.void,
          thread,
        );
        const rememberOp = yield* store.readWorkOperation(
          `sync:${space}:${remembered.receipt.operationId}`,
        );
        if (!rememberOp || rememberOp.kind !== "upsert")
          throw new Error("Expected a staged remember");
        const suggestions = makeMemorySaveSuggestions({
          sql,
          store,
          requireSharing: () => Effect.void,
          stableUuid: Service.memoryStableUuid,
        });
        const suggestion = input(800);
        yield* suggestions.onRefusedSave(
          {
            input: suggestion,
            thread,
            reason: "hub_unavailable",
            knownRevisions: revisions,
            lineageComplete: true,
            forgetGeneration: yield* suggestionForgetGeneration(space).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          },
          Effect.void,
        );
        assert.deepStrictEqual(
          yield* service.acceptSuggestion(
            { memorySpaceId: space, suggestionId: suggestion.memoryId },
            Effect.void,
          ),
          { status: "pending" },
        );
        const [row] = yield* sql<{
          accept_operation_id: string;
        }>`SELECT accept_operation_id FROM memory_save_suggestions WHERE id=${suggestion.memoryId}`;
        const acceptOp = yield* store.readWorkOperation(
          `sync:${space}:${row?.accept_operation_id}`,
        );
        if (!acceptOp || acceptOp.kind !== "upsert")
          throw new Error("Expected a staged acceptance");
        for (const op of [rememberOp, acceptOp]) {
          assert.sameMembers([...op.payload.derivedFromMemoryRevisions], revisions);
          assert.propertyVal(yield* admit(op), "outcome", "accepted");
        }
        yield* service.forget(
          {
            memorySpaceId: space,
            memoryId: savedSource.memoryId,
            operationId: M.MemoryOperationId.make(id(99002)),
            expectedHeads: [newest.revision.revisionId],
          },
          Effect.void,
        );
        for (const op of [rememberOp, acceptOp, exactOp])
          assert.propertyVal(
            (yield* store.loadAggregate(space, op.memoryId)).item,
            "status",
            "blocked",
          );
      }),
    ),
);

it.effect.each([
  "lost ACK",
  "unavailable before admission",
  "an existing pending suggestion",
  "acceptance starts first",
] as const)("an uncertain remember waits for its original operation after %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(at);
      const hub = yield* makeEnvironment(hubId);
      yield* enroll(hub.sql);
      const admit = (op: M.MemoryOperation) =>
        hub.service.admitHubOperation({ authority: authority(), operation: op });
      let submit: Effect.Effect<void, Service.MemoryServiceError> = Effect.void;
      const e = yield* makeEnvironment(
        memberId,
        Service.layerWithSourceReadAuthority(
          () => Effect.fail(new Service.MemoryAccessError({ code: "unavailable" })),
          Effect.suspend(() => submit),
        ),
      );
      yield* e.sql`ALTER TABLE orchestration_events ADD COLUMN event_id TEXT`;
      yield* e.sql`ALTER TABLE orchestration_events ADD COLUMN sequence INTEGER`;
      const revisions: M.MemoryRevisionId[] = [];
      for (let n = 10000; n < 10101; n++) {
        const source = input(n);
        yield* e.service.upsert(source, Effect.void);
        const op = yield* operation(e.store, source);
        assert.propertyVal(yield* admit(op), "outcome", "accepted");
        revisions.push(op.revision.revisionId);
      }
      yield* e.store.appendThreadLineage(thread, space, revisions);
      const request = {
        memorySpaceId: space,
        scope: "user" as const,
        text: "synthetic uncertain save",
      };
      const acceptFirst = scenario === "acceptance starts first";
      const existing = scenario === "an existing pending suggestion" || acceptFirst;
      if (existing) {
        const before = yield* e.service.remember(request, Effect.void, thread).pipe(Effect.flip);
        assert.propertyVal(before, "code", "hub_upgrade_required");
        assert.include(
          (yield* e.service.listSuggestions({ memorySpaceId: space }, Effect.void))[0],
          { state: "pending" },
        );
      }
      yield* e.store.transact(e.store.learnHubFloor(space, at));
      const readOriginal = Effect.gen(function* () {
        const [row] = yield* e.sql<{
          id: string;
        }>`SELECT id FROM memory_outbox WHERE json_extract(metadata_json,'$.authorityFirst') IS NOT NULL`;
        if (!row) throw new Error("Expected the original staged operation");
        const op = yield* e.store.readWorkOperation(row.id);
        if (!op || op.kind !== "upsert") throw new Error("Expected a staged upsert");
        return { workId: row.id, op };
      });
      if (scenario === "lost ACK" || acceptFirst) {
        yield* hub.store.transact(hub.store.learnHubFloor(space, at));
        submit = readOriginal.pipe(
          Effect.flatMap(({ op }) => admit(op)),
          Effect.orDie,
          Effect.asVoid,
        );
      } else submit = Effect.fail(new Store.MemoryStoreConflict({ code: "hub_unavailable" }));
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      if (existing)
        submit = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(released)),
          Effect.andThen(submit),
        );
      const attempt = e.service.remember(request, Effect.void, thread).pipe(Effect.flip);
      if (acceptFirst) {
        const [suggestion] = yield* e.service.listSuggestions(
          { memorySpaceId: space },
          Effect.void,
        );
        if (!suggestion) throw new Error("Expected a pending suggestion");
        assert.deepStrictEqual(
          yield* e.service.acceptSuggestion(
            { memorySpaceId: space, suggestionId: suggestion.suggestionId },
            Effect.void,
          ),
          { status: "pending" },
        );
        const inFlight = yield* Effect.forkScoped(attempt);
        yield* Deferred.await(entered);
        const rows =
          yield* e.sql`SELECT id FROM memory_outbox WHERE memory_id=${suggestion.suggestionId}`;
        yield* Deferred.succeed(released, undefined);
        assert.propertyVal(yield* Fiber.join(inFlight), "code", "hub_unavailable");
        assert.lengthOf(rows, 1);
      } else if (existing) {
        const inFlight = yield* Effect.forkScoped(attempt);
        yield* Deferred.await(entered);
        const { op } = yield* readOriginal;
        const address = { memorySpaceId: space, suggestionId: op.memoryId };
        assert.deepStrictEqual(yield* e.service.acceptSuggestion(address, Effect.void), {
          status: "pending",
        });
        const rows = yield* e.sql`SELECT id FROM memory_outbox WHERE memory_id=${op.memoryId}`;
        yield* Deferred.succeed(released, undefined);
        assert.propertyVal(yield* Fiber.join(inFlight), "code", "hub_unavailable");
        assert.lengthOf(rows, 1);
      } else assert.propertyVal(yield* attempt, "code", "hub_unavailable");
      const { workId, op } = yield* readOriginal;
      const address = { memorySpaceId: space, suggestionId: op.memoryId };
      const waiting = yield* e.service.listSuggestions({ memorySpaceId: space }, Effect.void);
      assert.lengthOf(waiting, 1);
      assert.include(waiting[0], { suggestionId: op.memoryId, state: "accepting" });
      assert.deepStrictEqual(yield* e.service.acceptSuggestion(address, Effect.void), {
        status: "pending",
      });
      assert.lengthOf(yield* e.sql`SELECT id FROM memory_outbox WHERE memory_id=${op.memoryId}`, 1);
      const receipt = yield* admit(op);
      yield* e.service.settleHubAcknowledgement({
        memorySpaceId: space,
        hubEnvironmentId: hubId,
        localEnvironmentId: memberId,
        workId,
        receipt,
        operation: { operationId: op.operationId, operationDigest: receipt.operationDigest },
        reauthorize: Effect.void,
      });
      const remaining = yield* e.service.listSuggestions({ memorySpaceId: space }, Effect.void);
      if (scenario === "lost ACK" || acceptFirst) {
        assert.propertyVal(receipt, "outcome", "accepted");
        assert.isEmpty(remaining);
        assert.lengthOf(
          yield* hub.sql`SELECT 1 FROM memory_hub_operations WHERE operation_id=${op.operationId}`,
          1,
        );
        return;
      }
      assert.include(receipt, { outcome: "rejected", failureCode: "hub_upgrade_required" });
      assert.lengthOf(remaining, 1);
      assert.include(remaining[0], { state: "pending", reason: "hub_upgrade_required" });
      yield* hub.store.transact(hub.store.learnHubFloor(space, at));
      for (let attempt = 0; attempt < 2; attempt++)
        assert.deepStrictEqual(yield* e.service.acceptSuggestion(address, Effect.void), {
          status: "pending",
        });
      const attempts = yield* e.sql<{
        id: string;
      }>`SELECT id FROM memory_outbox WHERE memory_id=${op.memoryId} AND id!=${workId}`;
      assert.lengthOf(attempts, 1);
      const retry = yield* e.store.readWorkOperation(attempts[0]!.id);
      if (!retry) throw new Error("Expected an acceptance retry");
      assert.propertyVal(yield* admit(retry), "outcome", "accepted");
    }),
  ),
);
