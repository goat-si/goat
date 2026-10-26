import {
  uuid,
  space,
  environmentId,
  sourceId,
  address,
  stamp,
  identity,
  resolver,
  setupImport,
  authority,
  seedMember,
  encodeUnknown,
} from "./MemoryImport.testkit.ts";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Worker from "./MemoryWorker.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";
import * as Settings from "../serverSettings.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/077_Memory.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/079_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import type { ImportItem, PreparedImportCommit } from "./imports/MemoryImportTypes.ts";
import * as Store from "./MemoryStore.ts";
// Opt in via goat-test-memory-growth; ordinary server runs skip this long measurement.
const growthLayer = (filename: string) => {
  const db = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* migration;
      yield* hubMigration;
      yield* searchMigration;
      yield* lineageMigration;
      yield* checkpointMigration;
      yield* revisionSizeMigration;
      yield* reportMigration;
      yield* usageMigration;
      yield* revertMigration;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA journal_mode=WAL");
      yield* sql`CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,deleted_at TEXT)`;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
  const quota = Quota.layer.pipe(Layer.provideMerge(Store.layer.pipe(Layer.provideMerge(db))));
  const service = Service.layer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provideMerge(quota),
    Layer.provide(identity),
    Layer.provide(resolver),
  );
  return Layer.mergeAll(Worker.layer, Hub.layer, Compactor.layer).pipe(
    Layer.provideMerge(service),
    Layer.provideMerge(Maintenance.layer.pipe(Layer.provideMerge(quota))),
    Layer.provideMerge(Hub.activityLayer),
    Layer.provide(
      Layer.succeed(Hub.MemoryHubConfiguration, {
        read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: environmentId }),
      }),
    ),
    Layer.provide(identity),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Settings.layerTest({ memoryHub: { mode: "hub", memorySpaceId: space } }, "memoryHub"),
    ),
    Layer.provide(
      Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "synthetic-growth" }),
    ),
    Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
    Layer.provide(
      Layer.mock(Generation.TextGeneration)({
        generateMemorySummary: () => Effect.die("growth fixture must never execute a provider"),
      }),
    ),
  );
};
describe.skipIf(process.env.GOAT_MEMORY_GROWTH !== "1")(
  "MemoryImport physical-growth source harness (requires GOAT_MEMORY_GROWTH=1)",
  () => {
    // oxlint-disable-next-line goat/no-test-timeout-or-unreasoned-skip -- Opt-in GOAT_MEMORY_GROWTH benchmark imports all 16 rounds of large source fixtures and retains their full growth.
    it.effect(
      "records deterministic 64 noop / 16 change / 32 forget-rebuild workload",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            // Preserve synthetic DB and metrics until the remote evidence collector retrieves them.
            const directory = yield* fs.makeTempDirectory({
              directory: yield* Config.String("WP5_GROWTH_ROOT").pipe(
                Config.orElse(() => Config.String("TMPDIR")),
              ),
              prefix: "wp5-growth-",
            });
            yield* Effect.logInfo(`WP5_GROWTH_ARTIFACTS ${directory}`);
            const filename = `${directory}/synthetic.sqlite`;
            yield* Effect.gen(function* () {
              yield* TestClock.setTime(Date.parse(stamp));
              yield* setupImport;
              yield* seedMember;
              const service = yield* Service.MemoryService;
              const ports = service.importPorts;
              const store = yield* Store.MemoryStore;
              const worker = yield* Worker.MemoryWorker;
              const compactor = yield* Compactor.MemoryCompactor;
              const quota = yield* Quota.MemoryQuotaService;
              const hub = yield* Hub.MemoryHubService;
              const sql = yield* SqlClient.SqlClient;
              const items = Array.from({ length: 64 }, (_, i) => ({
                sourceItemKey: `growth-${i}`,
                memoryId: M.MemoryId.make(uuid(10000 + Math.floor(i / 4))),
              }));
              const text = (identity: number, round: number) => {
                const prefix = `Synthetic growth ${identity} round ${round} `;
                return (
                  prefix +
                  "가".repeat(1300) +
                  "x".repeat(4096 - new TextEncoder().encode(prefix).length - 3900)
                );
              };
              const digest = (value: string) =>
                Service.memoryStableUuid(value).replaceAll("-", "").repeat(2);
              let allocation = 20000;
              const footprint = Effect.gen(function* () {
                return {
                  counters:
                    yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
                  registrations:
                    yield* sql`SELECT receipt_id,registration_json,completed_items_json FROM memory_import_receipts ORDER BY receipt_id`,
                  counts:
                    yield* sql`SELECT (SELECT count(*) FROM memory_revisions) AS revisions,(SELECT count(*) FROM memory_payloads) AS bodies,
                  (SELECT count(*) FROM memory_events) AS events,(SELECT count(*) FROM memory_outbox) AS work`,
                };
              });
              const refusals: {
                phase: string;
                round: number;
                dimension: string;
                current: number | undefined;
                limit: number;
              }[] = [];
              const resolutionRefusals: {
                round: number;
                index: number;
                receipt: M.MemoryHubReceipt;
              }[] = [];
              // Replace only model output; use the same lease and canonical Service commit
              // as MemorySyncService.runResolution, without a provider or background timers.
              const resolveChanged = (round: number) =>
                Effect.gen(function* () {
                  for (let index = 0; index < 16; index++) {
                    const id = M.MemoryId.make(uuid(10000 + index));
                    const aggregate = yield* store.loadAggregate(space, id);
                    if (aggregate.heads.length <= 1) continue;
                    const conflict = aggregate.conflicts.find((c) => c.status === "quarantined")!;
                    assert.isDefined(conflict);
                    allocation += 4;
                    const operationId = M.MemoryOperationId.make(uuid(allocation));
                    const revisionId = M.MemoryRevisionId.make(uuid(allocation + 1));
                    const resolutionId = M.MemoryResolutionId.make(uuid(allocation + 2));
                    const beforeClaim = yield* footprint;
                    const lease = yield* hub
                      .claim(
                        {
                          protocolVersion: 1,
                          memorySpaceId: space,
                          memoryId: id,
                          holderEnvironmentId: environmentId,
                          conflictId: conflict.conflictId,
                          conflictHeadSet: aggregate.heads,
                          attemptId: M.MemoryOperationId.make(uuid(allocation + 3)),
                          frozenDefaultModelSelection: {
                            instanceId: M.ProviderInstanceId.make("synthetic-growth"),
                            model: "synthetic-model",
                          },
                        },
                        authority.principal,
                      )
                      .pipe(
                        Effect.catchTags({
                          MemoryCapacityError: (error) =>
                            Effect.gen(function* () {
                              refusals.push({
                                phase: "resolve-claim",
                                round,
                                dimension: error.dimension,
                                current: error.current,
                                limit: error.limit,
                              });
                              assert.deepStrictEqual(yield* footprint, beforeClaim);
                              yield* fs.writeFileString(
                                `${directory}/claim-refusals.json`,
                                encodeUnknown(refusals),
                              );
                              return null;
                            }),
                        }),
                      );
                    if (lease === null) continue;
                    const head = aggregate.revisions.find(
                      (r) => r.revision.revisionId === aggregate.heads[0],
                    )!;
                    // Match Sync's closed lineage input: a previous resolution head
                    // carries dependencies even when fresh provider imports have none.
                    const dependencies = [
                      ...new Set([
                        ...aggregate.heads,
                        ...aggregate.revisions
                          .filter((r) => aggregate.heads.includes(r.revision.revisionId))
                          .flatMap((r) => r.payload!.derivedFromMemoryRevisions),
                      ]),
                    ];
                    const op: Extract<M.MemoryOperation, { kind: "resolve" }> = {
                      protocolVersion: 1,
                      kind: "resolve",
                      memorySpaceId: space,
                      memoryId: id,
                      originEnvironmentId: environmentId,
                      operationId,
                      expectedHeads: aggregate.heads,
                      conflictId: conflict.conflictId,
                      fencingToken: lease.fencingToken,
                      revision: {
                        ...head.revision,
                        operationId,
                        revisionId,
                        payloadRef: revisionId,
                        parents: aggregate.heads,
                        createdAtUtc: stamp,
                      },
                      payload: {
                        text: text(index, round),
                        evidence: head.payload!.evidence,
                        derivedFromMemoryRevisions: dependencies,
                      },
                      resolution: {
                        resolutionId,
                        memorySpaceId: space,
                        memoryId: id,
                        inputRevisionIds: aggregate.heads,
                        inputPayloadRefs: aggregate.heads.map(
                          (h) =>
                            aggregate.revisions.find((r) => r.revision.revisionId === h)!.revision
                              .payloadRef,
                        ),
                        judgmentRef: resolutionId,
                        requestedModelSelection: lease.frozenDefaultModelSelection,
                        effectiveProvider: M.ProviderDriverKind.make("codex"),
                        effectiveModel: "synthetic-model",
                        resolvingEnvironmentId: environmentId,
                        fencingToken: lease.fencingToken,
                        resultRevisionId: revisionId,
                        appliedAtUtc: stamp,
                        revertDeadlineUtc: M.MemoryUtcTimestamp.make(
                          DateTime.formatIso(
                            DateTime.makeUnsafe(Date.parse(stamp) + M.MEMORY_REVERT_WINDOW_MS),
                          ),
                        ),
                      },
                      resolutionPayload: {
                        resolutionId,
                        judgment: "Synthetic: keep the current source round.",
                      },
                    };
                    const receipt = yield* hub.applyResolution(
                      {
                        protocolVersion: 1,
                        memorySpaceId: space,
                        holderEnvironmentId: environmentId,
                        attemptId: lease.attemptId,
                        operation: op,
                      },
                      authority.principal,
                    );
                    if (receipt.outcome === "rejected") {
                      resolutionRefusals.push({ round, index, receipt });
                      yield* fs.writeFileString(
                        `${directory}/resolution-refusals.json`,
                        encodeUnknown(resolutionRefusals),
                      );
                      // Match Sync's terminal cleanup: a refused attempt must release its lease.
                      yield* hub.release(
                        {
                          protocolVersion: 1,
                          memorySpaceId: space,
                          memoryId: id,
                          conflictId: lease.conflictId,
                          holderEnvironmentId: environmentId,
                          attemptId: lease.attemptId,
                          fencingToken: lease.fencingToken,
                        },
                        authority.principal,
                      );
                      continue;
                    }
                    assert.strictEqual(receipt.outcome, "accepted");
                    assert.strictEqual((yield* store.loadAggregate(space, id)).heads.length, 1);
                  }
                });
              const runRound = (phase: "seed" | "noop" | "change", round: number) =>
                Effect.gen(function* () {
                  if (phase === "change") {
                    const previousRegistration = (yield* ports.readRegistration(
                      { ...address, sourceId, by: "source" },
                      Effect.void,
                    ))!;
                    yield* ports.saveRegistration(
                      {
                        ...address,
                        expectedVersion: previousRegistration.version,
                        next: {
                          ...previousRegistration,
                          version: previousRegistration.version + 1,
                          session: {
                            ...previousRegistration.session!,
                            sessionId: `growth-change-${round}`,
                            newItems: 0,
                            bodyBytes: 0,
                            applied: [],
                          },
                        },
                      },
                      Effect.void,
                    );
                  }
                  for (let chunk = 0; chunk < 2; chunk++) {
                    const reg = (yield* ports.readRegistration(
                      { ...address, sourceId, by: "source" },
                      Effect.void,
                    ))!;
                    const frozen = items.slice(chunk * 32, (chunk + 1) * 32).map((item, offset) => {
                      allocation += 3;
                      const body = text(
                        Math.floor((chunk * 32 + offset) / 4),
                        phase === "change" ? round : 0,
                      );
                      return {
                        selector: {
                          sourceItemKey: item.sourceItemKey,
                          sourceFingerprint: digest(body),
                          scope: { kind: "user" as const },
                        },
                        memoryId: item.memoryId,
                        operationId: M.MemoryOperationId.make(uuid(allocation)),
                        revisionId: M.MemoryRevisionId.make(uuid(allocation + 1)),
                        result: null,
                      };
                    });
                    allocation += 3;
                    const batchId = M.MemoryOperationId.make(uuid(allocation));
                    let batch: PreparedImportCommit["batch"] = {
                      ...address,
                      kind: "detailed",
                      codecVersion: 1,
                      sourceId,
                      sessionId: reg.session!.sessionId,
                      operationId: batchId,
                      selectionDigest: digest(`${phase}/${round}/${chunk}`),
                      selections: frozen,
                      createdAtUtc: stamp,
                      receipt: {
                        operationId: batchId,
                        sourceId,
                        sessionId: reg.session!.sessionId,
                        state: "partial",
                        remaining: 32,
                        items: [],
                        sessionNewItems: 0,
                        sessionBodyBytes: 0,
                      },
                    };
                    for (const selection of frozen) {
                      const index = items.findIndex(
                        (i) => i.sourceItemKey === selection.selector.sourceItemKey,
                      );
                      const body = text(Math.floor(index / 4), phase === "change" ? round : 0);
                      const previous =
                        (yield* ports.readItem(
                          { ...address, sourceId, sourceItemKey: selection.selector.sourceItemKey },
                          Effect.void,
                        )) ?? null;
                      const target = yield* ports.prepareTarget(
                        {
                          ...address,
                          memoryId: selection.memoryId,
                          scope: { kind: "user" },
                          acceptedRevisionId: previous?.accepted?.revisionId ?? null,
                        },
                        Effect.void,
                      );
                      const outcome: M.MemoryImportOutcome =
                        phase === "noop"
                          ? "noop"
                          : previous
                            ? target.heads.length === 1 &&
                              target.heads[0] === previous.accepted?.revisionId
                              ? "revised"
                              : "conflicted"
                            : target.alias
                              ? "aliased"
                              : "created";
                      const candidate = {
                        sourceItemKey: selection.selector.sourceItemKey,
                        sourceFingerprint: selection.selector.sourceFingerprint,
                        contentFingerprint: digest(body),
                        byteCount: 4096,
                        payload: {
                          text: body,
                          evidence: [
                            { origin: "import" as const, importSourceId: sourceId, messageIds: [] },
                          ],
                          derivedFromMemoryRevisions: [],
                        },
                      };
                      const next: ImportItem = {
                        ...address,
                        sourceId,
                        codecVersion: 1,
                        sourceItemKey: candidate.sourceItemKey,
                        memoryId: selection.memoryId,
                        scope: { kind: "user" },
                        accepted: previous?.accepted ?? null,
                        pending:
                          outcome === "noop"
                            ? (previous?.pending ?? null)
                            : {
                                sourceFingerprint: candidate.sourceFingerprint,
                                contentFingerprint: candidate.contentFingerprint,
                                revisionId: selection.revisionId,
                                operationId: selection.operationId,
                              },
                        rejected: null,
                        outcome,
                      };
                      const currentReg = (yield* ports.readRegistration(
                        { ...address, sourceId, by: "source" },
                        Effect.void,
                      ))!;
                      const beforeCommit = phase === "change" ? yield* footprint : null;
                      const committed = yield* ports
                        .commit(
                          {
                            registration: currentReg,
                            registrationVersion: currentReg.version,
                            batch,
                            selection: batch.selections.find(
                              (s) => s.operationId === selection.operationId,
                            )!,
                            candidate,
                            previous,
                            next,
                            expectedHeads: target.heads,
                            parents: previous?.accepted
                              ? [previous.accepted.revisionId]
                              : target.alias
                                ? [target.alias.revision.revisionId]
                                : [],
                            projectBinding: null,
                          },
                          Effect.void,
                        )
                        .pipe(
                          Effect.catchTags({
                            MemoryCapacityError: (error) =>
                              Effect.gen(function* () {
                                const refusal = {
                                  phase,
                                  round,
                                  dimension: error.dimension,
                                  current: error.current,
                                  limit: error.limit,
                                };
                                refusals.push(refusal);
                                yield* Console.log(`WP5_GROWTH_REFUSAL ${encodeUnknown(refusal)}`);
                                if (beforeCommit)
                                  assert.deepStrictEqual(yield* footprint, beforeCommit);
                                return null;
                              }),
                          }),
                        );
                      if (committed === null) continue;
                      if (outcome !== "noop") {
                        const operation = (yield* store.readWorkOperation(
                          `sync:${space}:${selection.operationId}`,
                        ))!;
                        const receipt = yield* service.admitHubOperation({ authority, operation });
                        if (receipt.outcome === "rejected") {
                          assert.strictEqual(
                            receipt.failureCode,
                            "capacity_exceeded",
                            encodeUnknown({ phase, round, index, receipt }),
                          );
                          assert.isDefined(receipt.capacity);
                          yield* Console.log(
                            `WP5_GROWTH_HUB_REFUSAL ${encodeUnknown({ phase, round, index, capacity: receipt.capacity })}`,
                          );
                        }
                        yield* store.acknowledgeOutbox(
                          `sync:${space}:${selection.operationId}`,
                          receipt,
                        );
                      }
                      const preflight = yield* ports.preflightBatch(
                        { ...batch, selectionDigest: batch.selectionDigest },
                        Effect.void,
                      );
                      if (preflight.kind === "partial") batch = preflight.batch;
                    }
                  }
                  if (phase === "change") yield* resolveChanged(round);
                  yield* worker.drain;
                }).pipe(
                  Effect.tapError((error) =>
                    Console.log(
                      `WP5_GROWTH_REFUSAL ${encodeUnknown({
                        phase,
                        round,
                        tag: error._tag,
                        ...(error._tag === "MemoryCapacityError"
                          ? {
                              dimension: error.dimension,
                              current: error.current,
                              limit: error.limit,
                            }
                          : {}),
                      })}`,
                    ),
                  ),
                );
              const samples: unknown[] = [];
              const csv = [
                "phase,iteration,clock,page_size,page_count,freelist_count,used_bytes,allocated_bytes,wal_bytes,identities,bodies,body_bytes,revisions,lineage,fts_rows,active,receipts,suppression",
              ];
              const sample = (phase: string, iteration: number) =>
                Effect.gen(function* () {
                  yield* worker.drain;
                  const checkpoint = yield* sql.unsafe<{
                    busy: number;
                    log: number;
                    checkpointed: number;
                  }>("PRAGMA wal_checkpoint(PASSIVE)");
                  const pages = (yield* sql.unsafe<{ page_count: number }>("PRAGMA page_count"))[0]!
                    .page_count;
                  const pageSize = (yield* sql.unsafe<{ page_size: number }>(
                    "PRAGMA page_size",
                  ))[0]!.page_size;
                  const free = (yield* sql.unsafe<{ freelist_count: number }>(
                    "PRAGMA freelist_count",
                  ))[0]!.freelist_count;
                  const walBytes = yield* fs.stat(`${filename}-wal`).pipe(
                    Effect.map((s) => Number(s.size)),
                    Effect.orElseSucceed(() => null),
                  );
                  // Read both total pages and harness allocation before writing this sample.
                  const allocation = yield* store.measureAllocation();
                  const growth = yield* quota.recordStorageSample(environmentId, { walBytes });
                  const counts = (yield* sql<{
                    identities: number;
                    bodies: number;
                    bodyBytes: number;
                    revisions: number;
                    lineage: number;
                    fts: number;
                    active: number;
                    receipts: number;
                    suppression: number;
                  }>`SELECT
            (SELECT count(*) FROM memory_identity_ledger WHERE space=${space}) AS identities,
            (SELECT count(*) FROM memory_payloads WHERE space=${space}) AS bodies,
            (SELECT coalesce(sum(length(CAST(body_json AS BLOB))),0) FROM memory_payloads WHERE space=${space}) AS bodyBytes,
            (SELECT count(*) FROM memory_revisions WHERE space=${space}) AS revisions,
            (SELECT count(*) FROM memory_import_lineage WHERE space=${space}) AS lineage,
            (SELECT count(*) FROM memory_items_fts) AS fts,
            (SELECT count(*) FROM memory_items WHERE space=${space} AND status='active') AS active,
            (SELECT count(*) FROM memory_import_receipts WHERE space=${space}) AS receipts,
            (SELECT count(*) FROM memory_import_keys WHERE space=${space} AND key_kind IN ('sourceKey','content','sourceExclusion')) AS suppression`)[0]!;
                  const sampleTable = allocation.tables.find(
                    (t) => t.table === "memory_storage_samples",
                  );
                  const noopRows = yield* sql<{ kind: string; rows: number; bytes: number }>`
                  SELECT json_extract(completed_items_json,'$.kind') AS kind,count(*) AS rows,
                  sum(length(CAST(completed_items_json AS BLOB))) AS bytes FROM memory_import_receipts
                  WHERE record_kind='batch' GROUP BY kind`;
                  const metrics = {
                    phase,
                    iteration,
                    clock: yield* Clock.currentTimeMillis,
                    seed: "wp5-growth-v1",
                    allowanceBytes: 1048576,
                    drain: "MemoryWorker.drain",
                    pageSize,
                    pages,
                    free,
                    usedBytes: (pages - free) * pageSize,
                    allocatedBytes: pages * pageSize,
                    walBytes,
                    checkpoint: checkpoint[0] ?? null,
                    sample: growth.current,
                    freshAllocation: allocation,
                    harnessSampleAllocatedBytes: sampleTable?.allocatedBytes ?? 0,
                    productUsedBytes:
                      (pages - free) * pageSize - (sampleTable?.allocatedBytes ?? 0),
                    noopGuards: noopRows,
                    sharedNoopResults:
                      yield* sql`SELECT count(*) AS rows,coalesce(sum(length(CAST(result_json AS BLOB))),0) AS bytes FROM memory_import_noop_results`,
                    workKinds:
                      yield* sql`SELECT kind,status,count(*) AS rows FROM memory_outbox GROUP BY kind,status`,
                    freshLogicalBytes: yield* store.logicalBytes,
                    checkpointAccounting: {
                      usage: yield* store.transact(store.readHubUsageTx(space)).pipe(
                        Effect.map((u) => ({
                          requiredCheckpointBoundBytes: u.requiredCheckpointBoundBytes,
                          stagingBytes: u.stagingBytes,
                          checkpointBytes: u.checkpointBytes,
                          publishedPinnedBytes: u.publishedPinnedBytes,
                          consumedBytes: u.checkpointReservationConsumedBytes,
                        })),
                      ),
                      counters:
                        yield* sql`SELECT space,dimension,value FROM memory_quota_counters WHERE scope_key='' AND (space='_hub_global' OR space=${space}) AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows','hub_snapshot_generation','import_metadata','import_staging','hub_private_metadata') ORDER BY space,dimension`,
                    },
                    counts,
                  };
                  samples.push(metrics);
                  csv.push(
                    [
                      phase,
                      iteration,
                      metrics.clock,
                      pageSize,
                      pages,
                      free,
                      metrics.usedBytes,
                      metrics.allocatedBytes,
                      walBytes ?? "unavailable",
                      counts.identities,
                      counts.bodies,
                      counts.bodyBytes,
                      counts.revisions,
                      counts.lineage,
                      counts.fts,
                      counts.active,
                      counts.receipts,
                      counts.suppression,
                    ].join(","),
                  );
                  yield* fs.writeFileString(`${directory}/samples.json`, encodeUnknown(samples));
                  yield* fs.writeFileString(`${directory}/samples.csv`, csv.join("\n") + "\n");
                  yield* Console.log(`WP5_GROWTH_SAMPLE ${encodeUnknown(metrics)}`);
                  return metrics;
                });
              yield* runRound("seed", 0);
              const baseline = yield* sample("seed", 0);
              assert.strictEqual(baseline.counts.identities, 16);
              assert.strictEqual(baseline.counts.bodies, 16);
              const noopSamples: (typeof baseline)[] = [];
              for (let round = 1; round <= 64; round++) {
                yield* runRound("noop", round);
                if (round % 16 === 0) {
                  const measured = yield* sample("noop", round);
                  assert.deepStrictEqual(
                    [
                      measured.counts.identities,
                      measured.counts.bodies,
                      measured.counts.bodyBytes,
                      measured.counts.revisions,
                      measured.counts.lineage,
                      measured.counts.fts,
                    ],
                    [
                      baseline.counts.identities,
                      baseline.counts.bodies,
                      baseline.counts.bodyBytes,
                      baseline.counts.revisions,
                      baseline.counts.lineage,
                      baseline.counts.fts,
                    ],
                  );
                  noopSamples.push(measured);
                }
              }
              for (let round = 1; round <= 16; round++) {
                yield* runRound("change", round);
                if (round % 4 === 0) yield* sample("change", round);
              }
              const changed = yield* sample("change", 16);
              const oldHeads = new Map<M.MemoryId, M.MemoryRevisionId>();
              for (let index = 0; index < 16; index++) {
                const id = M.MemoryId.make(uuid(10000 + index));
                const target = yield* store.loadAggregate(space, id);
                oldHeads.set(id, target.heads[0]!);
                const operationId = M.MemoryOperationId.make(uuid(90000 + index));
                yield* service.forget(
                  { memorySpaceId: space, memoryId: id, operationId, expectedHeads: target.heads },
                  Effect.void,
                );
                const operation = (yield* store.readWorkOperation(`sync:${space}:${operationId}`))!;
                const receipt = yield* store.transact(
                  service.admitHubOperationTx({ authority, operation }),
                );
                yield* store.acknowledgeOutbox(`sync:${space}:${operationId}`, receipt);
              }
              yield* worker.drain;
              const horizon = Math.max(
                M.MEMORY_IMPORT_BATCH_RETENTION_MS,
                M.MEMORY_LOG_RETENTION_MS,
                M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS,
              );
              const rebuildSamples: (typeof baseline)[] = [];
              for (let cycle = 1; cycle <= 32; cycle++) {
                yield* TestClock.setTime(Date.parse(stamp) + cycle * (horizon - 1));
                yield* compactor.compact(authority.principal);
                yield* worker.drain;
                for (const [id, revisionId] of oldHeads) {
                  const current = yield* store.loadAggregate(space, id);
                  yield* store.enqueueWork({
                    id: `growth-rebuild:${cycle}:${id}`,
                    space,
                    memoryId: id,
                    kind: "rebuild",
                    status: "pending",
                    metadata: { kind: "rebuild", revisionId, generation: current.generation },
                    payloadRef: null,
                    attempt: 0,
                    nextAttemptAt: 0,
                    claimedBy: null,
                    claimedUntil: null,
                  });
                }
                yield* worker.drain;
                const measured = yield* sample("rebuild", cycle);
                assert.strictEqual(measured.counts.bodies, 0);
                assert.strictEqual(measured.counts.fts, 0);
                rebuildSamples.push(measured);
              }
              // Keep unsupported metrics explicit. Source measurements do not certify packaging.
              const spread = (samples: readonly (typeof baseline)[]) =>
                Math.max(...samples.map((s) => s.usedBytes)) -
                Math.min(...samples.map((s) => s.usedBytes));
              const positiveGrowth = (measured: readonly (typeof baseline)[]) => {
                let low = Infinity;
                let growth = 0;
                for (const s of measured) {
                  low = Math.min(low, s.productUsedBytes);
                  growth = Math.max(growth, s.productUsedBytes - low);
                }
                return growth;
              };
              const gates = {
                noopSpreadBytes: spread(noopSamples),
                rebuildSpreadBytes: spread(rebuildSamples.slice(8)),
                rebuildProductGrowthBytes: positiveGrowth(rebuildSamples.slice(8)),
                activeAfterChange: changed.counts.active,
                resolutionRefusals,
                refusals,
                allowanceBytes: 1048576,
                packaged: "NOT_RUN",
              };
              yield* fs.writeFileString(`${directory}/gates.json`, encodeUnknown(gates));
              yield* Console.log(`WP5_GROWTH_GATES ${encodeUnknown(gates)}`);
              assert.isEmpty(resolutionRefusals, "synthetic resolutions must all be admitted");
              assert.isEmpty(refusals, "all local imports and claims must be admitted");
              assert.strictEqual(
                changed.counts.active,
                16,
                "all changed aliases must converge to 16 live identities",
              );
              assert.isAtMost(
                spread(noopSamples),
                1048576,
                "noop physical growth must plateau after warmup",
              );
              assert.isAtMost(
                positiveGrowth(rebuildSamples.slice(8)),
                1048576,
                "forget-rebuild product increase from a preceding post-warmup minimum must stay within allowance",
              );
            }).pipe(Effect.provide(growthLayer(filename)));
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      // Full admission now retains all 16 rounds instead of stopping growth at capacity.
      { timeout: 3600000 },
    );
  },
);
