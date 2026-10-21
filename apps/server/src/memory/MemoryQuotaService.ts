import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Store from "./MemoryStore.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";

export class MemoryQuotaService extends Context.Service<
  MemoryQuotaService,
  {
    readonly readStorageStatus: (input: {
      memorySpaceId: M.MemorySpaceId;
      environmentId: M.EnvironmentId;
    }) => Effect.Effect<M.MemoryStorageStatus, Store.MemoryStorageError>;
    readonly readUnboundStorageStatus: (input: {
      environmentId: M.EnvironmentId;
    }) => Effect.Effect<M.MemoryStorageStatus, Store.MemoryStorageError>;
    readonly withAdmission: <A, E, R>(
      input: {
        readonly operation: M.MemoryOperation;
        readonly admission: Store.MemoryAdmissionContext;
        readonly environmentId: M.EnvironmentId;
        readonly receipt?: M.MemoryHubReceipt | M.MemoryMutationReceipt;
      },
      commit: Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | Store.MemoryStorageError | Store.MemoryCapacityError | Store.MemoryStoreConflict,
      R
    >;
    readonly commit: <E, R>(
      decision: Store.MemoryDecision,
      environmentId: M.EnvironmentId,
      permit: Effect.Effect<void, E, R>,
    ) => Effect.Effect<
      Store.StoredReceipt,
      E | Store.MemoryStorageError | Store.MemoryCapacityError | Store.MemoryStoreConflict,
      R
    >;
    readonly recordStorageSample: (
      environmentId: M.EnvironmentId,
      sharedMetrics?: { readonly walBytes: number | null },
      /** A measurement the caller just took, so one maintenance cycle walks the btrees once. */
      measured?: Effect.Success<ReturnType<Store.MemoryStore["Service"]["measureAllocation"]>>,
    ) => Effect.Effect<M.MemoryStorageGrowth, Store.MemoryStorageError>;
    readonly readStorageGrowth: (
      environmentId: M.EnvironmentId,
    ) => Effect.Effect<M.MemoryStorageGrowth, Store.MemoryStorageError>;
  }
>()("goat/memory/MemoryQuotaService") {}
const receiptJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Union([M.MemoryHubReceipt, M.MemoryMutationReceipt])),
);
const resolutionPayloadJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryResolutionPayload));
const payloadJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryPayload));
const suppressionJson = Schema.encodeEffect(Schema.fromJsonString(M.MemorySuppressionRecord));
const capacityDimensionDecode = Schema.decodeUnknownEffect(M.MemoryCapacityDimension);
const sampleDecode = Schema.decodeUnknownEffect(M.MemoryStorageSample);
const storageStatusDecode = Schema.decodeUnknownEffect(M.MemoryStorageStatus);
const growthDecode = Schema.decodeUnknownEffect(M.MemoryStorageGrowth);
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const sourceKeyJson = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceKey));
const contentJson = Schema.encodeEffect(Schema.fromJsonString(M.MemoryContentSuppression));
const exclusionJson = Schema.encodeEffect(Schema.fromJsonString(M.MemorySourceExclusion));
const keyOf = (record: M.MemorySuppressionRecord) =>
  record.kind === "sourceKey"
    ? sourceKeyJson(record.sourceKey)
    : record.kind === "content"
      ? contentJson(record.content)
      : exclusionJson(record.exclusion);
const storageError = (cause: unknown) =>
  new Store.MemoryStorageError({ stage: "quota-codec", cause });

/** Exact-day endpoints; missing metrics or days remain unavailable rather than becoming zero growth. */
function storageDeltas(
  current: M.MemoryStorageSample | null,
  samples: ReadonlyArray<M.MemoryStorageSample>,
  clockDiscontinuity = false,
): ReadonlyArray<M.MemoryStorageDelta> {
  return ([1, 7, 30] as const).flatMap((days) =>
    M.MemoryStorageMetric.literals.map((metric) => {
      const target = current
        ? DateTime.formatIsoDateUtc(
            DateTime.add(DateTime.makeUnsafe(current.utcDay), { days: -days }),
          )
        : null;
      const baseline = samples.find((sample) => sample.utcDay === target);
      const elapsed =
        current && baseline
          ? Date.parse(current.measuredAtUtc) - Date.parse(baseline.measuredAtUtc)
          : null;
      const reason =
        clockDiscontinuity || (elapsed !== null && elapsed <= 0)
          ? ("clock_discontinuity" as const)
          : !baseline
            ? ("missing_baseline" as const)
            : !current || current[metric] === null || baseline[metric] === null
              ? ("metric_unavailable" as const)
              : null;
      return {
        days,
        metric,
        status: reason ? ("unavailable" as const) : ("available" as const),
        baselineAtUtc: baseline?.measuredAtUtc ?? null,
        currentAtUtc: current?.measuredAtUtc ?? null,
        elapsedMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
        deltaBytes: reason || !current || !baseline ? null : current[metric]! - baseline[metric]!,
        reason,
      };
    }),
  );
}
const make = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  const withAdmission: MemoryQuotaService["Service"]["withAdmission"] = (input, commit) =>
    store.transact(
      Effect.gen(function* () {
        const op = input.operation;
        if (input.admission.kind === "hubAdmission") {
          if (yield* store.readHubReceiptTx(op.memorySpaceId, op.operationId)) return yield* commit;
          // Local canonical data is already accounted for; append still performs hub ledger admission.
          if (yield* store.receipt(op.memorySpaceId, op.operationId)) return yield* commit;
        } else if (yield* store.receipt(op.memorySpaceId, op.operationId)) return yield* commit;
        // Quota charges the replaced live payload, which is always a current head.
        const current = yield* store.loadAggregate(
          op.memorySpaceId,
          op.memoryId,
          { heads: true },
          {},
        );
        const scope =
          op.kind === "forget"
            ? (current.identity?.scope ?? { kind: "user" as const })
            : op.revision.scope;
        const usage = yield* store.usage(op.memorySpaceId, scope);
        const charges: Store.MemoryQuotaCharge[] = [];
        const charge = (
          dimension: string,
          used: number,
          delta: number,
          limit: number,
          scopeKey = "space",
        ) =>
          charges.push({
            space: op.memorySpaceId,
            dimension,
            scopeKey,
            current: used,
            delta,
            limit,
          });
        const identityNew = current.identity === undefined;
        const firstForget =
          op.kind === "forget" && current.tombstone === undefined && current.identity !== undefined;
        const heldReservation = yield* store.readForgetReservation(op.memorySpaceId, op.memoryId);
        const neededReservation =
          op.kind !== "forget" && !current.tombstone
            ? yield* store.firstForgetReservation(op)
            : heldReservation;
        const oldLive = current.item !== undefined && current.item.status !== "forgotten";
        const addedLive =
          op.kind === "forget" ? -Number(oldLive) : Number(!oldLive && !current.tombstone);
        const metadataBytes = yield* store.operationMetadataBytes(op);
        const receipt = input.receipt ?? {
          operationId: op.operationId,
          memoryId: op.memoryId,
          outcome: op.kind === "forget" ? ("deleted" as const) : ("accepted" as const),
          revisionId: op.kind === "forget" ? null : op.revision.revisionId,
          pendingSync: input.admission.kind === "localIntent",
        };
        const receiptBytes = utf8(yield* receiptJson(receipt).pipe(Effect.mapError(storageError)));
        const payloadBytes =
          op.kind === "forget"
            ? 0
            : utf8(yield* payloadJson(op.payload).pipe(Effect.mapError(storageError)));
        const oldPayloadBytes = yield* Effect.reduce(
          [
            ...new Map(
              current.revisions
                .filter(
                  (pair) =>
                    current.heads.includes(pair.revision.revisionId) && pair.payload !== null,
                )
                .map((pair) => [pair.revision.payloadRef, pair]),
            ).values(),
          ],
          () => 0,
          (sum, pair) => Effect.map(payloadJson(pair.payload!), (json) => sum + utf8(json)),
        ).pipe(Effect.mapError(storageError));
        if (input.admission.kind === "localIntent" && op.kind !== "forget") {
          const brake = yield* store.ftsState(input.environmentId);
          if (brake.state === "braked")
            return yield* new Store.MemoryCapacityError({
              dimension: "fts_admission_brake",
              limit: M.MEMORY_FTS_ALLOCATED_BRAKE_BYTES,
            });
        }
        charge("lifetime_ids", usage.lifetimeIds, Number(identityNew), M.MEMORY_MAX_LIFETIME_IDS);
        charge(
          "receipts",
          usage.receipts,
          firstForget ? 0 : 1 + Number(identityNew && op.kind !== "forget"),
          M.MEMORY_DEDUP_MAX_RECEIPTS,
        );
        // Identity core and its first-forget receipt are charged before normal writers can spend them.
        charge(
          "permanent_metadata",
          usage.permanentBytes,
          (identityNew ? M.MEMORY_IDENTITY_CORE_MAX_BYTES : 0) +
            (op.kind !== "forget"
              ? Math.max(0, neededReservation.bytes - heldReservation.bytes)
              : identityNew
                ? M.MEMORY_PAYLOAD_MAX_UTF8_BYTES
                : 0) +
            (firstForget ? 0 : M.MEMORY_COMPACT_RECEIPT_MAX_BYTES) *
              (1 + Number(identityNew && op.kind !== "forget")),
          M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
        );
        if (op.kind !== "forget")
          charge(
            "import_source_items",
            usage.keys,
            Math.max(0, neededReservation.keys - heldReservation.keys),
            M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
          );
        if (op.kind === "forget") {
          const existing = yield* store.readSuppressions(op.memorySpaceId, op.memoryId);
          const keys = new Set(
            yield* Effect.forEach(existing, (record) =>
              Effect.map(keyOf(record), (text) => record.kind + ":" + text),
            ).pipe(Effect.mapError(storageError)),
          );
          const t = op.tombstone;
          const records = Store.memorySuppressionRecords(t);
          let newKeys = 0,
            newBytes = 0;
          for (const record of records) {
            const key =
              record.kind + ":" + (yield* keyOf(record).pipe(Effect.mapError(storageError)));
            if (keys.has(key)) continue;
            keys.add(key);
            newKeys++;
            newBytes += utf8(yield* suppressionJson(record).pipe(Effect.mapError(storageError)));
          }
          // Consume only the reserved first fragment; expanded excess still needs admission.
          charge(
            "import_source_items",
            usage.keys,
            newKeys - (firstForget ? heldReservation.keys : 0),
            M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
          );
          charge(
            "permanent_metadata",
            usage.permanentBytes,
            newBytes -
              (firstForget
                ? heldReservation.bytes
                : identityNew
                  ? M.MEMORY_PAYLOAD_MAX_UTF8_BYTES
                  : 0),
            M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
          );
        } else {
          const scopeDimension =
            scope.kind === "user"
              ? "user_items"
              : scope.kind === "project"
                ? "project_items"
                : op.revision.provenance.sourceThread
                  ? "thread_summaries"
                  : "thread_items";
          const scopeLimit =
            scope.kind === "user"
              ? M.MEMORY_USER_MAX_ITEMS
              : scope.kind === "project"
                ? M.MEMORY_PROJECT_MAX_ITEMS
                : scopeDimension === "thread_summaries"
                  ? M.MEMORY_THREAD_MAX_SUMMARIES
                  : M.MEMORY_THREAD_MAX_EXPLICIT_ITEMS;
          charge(
            scopeDimension,
            scopeDimension === "thread_summaries"
              ? usage.scopeSummaries
              : scopeDimension === "thread_items"
                ? usage.scopeExplicit
                : usage.scopeItems,
            addedLive,
            scopeLimit,
            scope.kind === "user"
              ? "user"
              : scope.kind === "thread"
                ? `${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`
                : scope.projectKey.kind === "repository"
                  ? scope.projectKey.groupingKey
                  : scope.projectKey.sharedProjectId,
          );
          charge("space_live_items", usage.spaceItems, addedLive, M.MEMORY_SPACE_MAX_LIVE_ITEMS);
          charge(
            "environment_live_items",
            usage.environmentItems,
            addedLive,
            M.MEMORY_ENVIRONMENT_MAX_LIVE_ITEMS,
          );
          charge(
            "live_payload_bytes",
            usage.liveBytes,
            payloadBytes - oldPayloadBytes,
            M.MEMORY_LIVE_MAX_PAYLOAD_BYTES,
          );
          charge(
            "history",
            usage.historyBytes,
            (op.kind === "upsert" && op.revision.payloadRef !== op.revision.revisionId
              ? 0
              : oldPayloadBytes) +
              (op.kind === "resolve"
                ? utf8(
                    yield* resolutionPayloadJson(op.resolutionPayload).pipe(
                      Effect.mapError(storageError),
                    ),
                  )
                : 0),
            M.MEMORY_HISTORY_MAX_PAYLOAD_BYTES,
          );
          charge(
            "work_items",
            usage.workItems,
            input.admission.kind === "localIntent" ? 1 : 0,
            M.MEMORY_WORK_MAX_PENDING_ITEMS,
          );
          charge(
            "work_bytes",
            usage.workBytes,
            input.admission.kind === "localIntent" ? metadataBytes : 0,
            M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
          );
          charge("log_tail_rows", usage.logRows, 1, M.MEMORY_LOG_MAX_TAIL_ROWS);
          charge(
            "log_tail_bytes",
            usage.logBytes,
            metadataBytes + receiptBytes,
            M.MEMORY_LOG_MAX_TAIL_BYTES,
          );
        }
        if (input.admission.kind !== "hubAdmission") {
          const baselines: Record<string, number> = {
            lifetime_ids: usage.environmentLifetimeIds,
            receipts: usage.environmentReceipts,
            permanent_metadata: usage.environmentPermanentBytes,
            live_payload_bytes: usage.environmentLiveBytes,
            history: usage.environmentHistoryBytes,
          };
          for (const entry of charges.slice()) {
            const current = baselines[entry.dimension];
            if (current !== undefined)
              charges.push({ ...entry, space: `_environment:${input.environmentId}`, current });
          }
        }
        const combined = new Map<string, Store.MemoryQuotaCharge>();
        for (const next of charges) {
          const key = `${next.space}:${next.dimension}:${next.scopeKey}`;
          const old = combined.get(key);
          combined.set(key, old ? { ...old, delta: old.delta + next.delta } : next);
        }
        yield* store.reserve(input.admission, [...combined.values()]);
        return yield* commit;
      }),
    );
  const commit: MemoryQuotaService["Service"]["commit"] = Effect.fn("MemoryQuotaService.commit")(
    function* <E, R>(
      decision: Store.MemoryDecision,
      environmentId: M.EnvironmentId,
      permit: Effect.Effect<void, E, R>,
    ) {
      return yield* store.transact(
        Effect.gen(function* () {
          yield* permit;
          const op = decision.operation;
          const replay = yield* store.receipt(op.memorySpaceId, op.operationId);
          if (replay) {
            if (
              replay.operationDigest !== decision.operationDigest &&
              (decision.admission.kind !== "localIntent" ||
                replay.receipt.forgetExpansion?.requestDigest !== decision.operationDigest)
            )
              return yield* new Store.MemoryStoreConflict({ code: "operation_id_reused" });
            const promote =
              decision.admission.kind === "approvedReplica" &&
              "hubSequence" in decision.receipt &&
              decision.receipt.hubSequence !== null &&
              (!("hubSequence" in replay.receipt) || replay.receipt.hubSequence === null);
            if (promote) return yield* store.apply(decision);
            return replay;
          }
          // Only a local first forget reads payloads: the source evidence it must exclude.
          const aggregate = yield* store.loadAggregate(
            op.memorySpaceId,
            op.memoryId,
            op.kind === "forget" ? { when: Store.hasSourceEvidence } : {},
            {},
          );
          const identity = decision.identity ??
            aggregate.identity ?? {
              memorySpaceId: op.memorySpaceId,
              memoryId: op.memoryId,
              scope: op.kind === "forget" ? { kind: "user" as const } : op.revision.scope,
              creatingEnvironmentId: op.originEnvironmentId,
              createOperationId: op.operationId,
              createdAtUtc:
                op.kind === "forget" ? op.tombstone.deletedAtUtc : op.revision.createdAtUtc,
            };
          if (
            op.kind === "forget" &&
            decision.admission.kind === "localIntent" &&
            aggregate.identity &&
            !aggregate.tombstone &&
            decision.receipt.outcome !== "rejected" &&
            !(yield* store.receipt(op.memorySpaceId, op.operationId))
          ) {
            const reservation = yield* store.readForgetReservation(op.memorySpaceId, op.memoryId);
            const records = Store.memorySuppressionRecords(op.tombstone);
            const reservedKeys = new Set<string>();
            for (const { revision, payload } of aggregate.revisions) {
              const { sourceThread, sourceWatermark } = revision.provenance;
              if (!sourceThread || !sourceWatermark) continue;
              for (const messageId of new Set(
                (payload?.evidence ?? []).flatMap((e) => e.messageIds),
              ))
                reservedKeys.add(
                  "sourceExclusion:" +
                    (yield* exclusionJson({
                      sourceThread,
                      sourceWatermark,
                      messageIds: [messageId],
                    }).pipe(Effect.mapError(storageError))),
                );
            }
            const unique = new Map<string, number>();
            for (const record of records) {
              const key =
                record.kind + ":" + (yield* keyOf(record).pipe(Effect.mapError(storageError)));
              unique.set(
                key,
                utf8(yield* suppressionJson(record).pipe(Effect.mapError(storageError))),
              );
            }
            const selected = new Set<string>();
            let baseBytes = 0;
            // Reserved source evidence wins over optional expansion of the delete request.
            for (const [key, bytes] of [...unique].sort(
              ([a], [b]) => Number(reservedKeys.has(b)) - Number(reservedKeys.has(a)),
            )) {
              if (selected.size < reservation.keys && baseBytes + bytes <= reservation.bytes) {
                selected.add(key);
                baseBytes += bytes;
              }
            }
            const fragment = (included: ReadonlySet<string>) =>
              Effect.gen(function* () {
                const sourceKeys: M.MemorySourceKey[] = [];
                const content: M.MemoryContentSuppression[] = [];
                const exclusions: M.MemorySourceExclusion[] = [];
                for (const sourceKey of op.tombstone.suppressedSourceKeys)
                  if (
                    included.has(
                      "sourceKey:" +
                        (yield* sourceKeyJson(sourceKey).pipe(Effect.mapError(storageError))),
                    )
                  )
                    sourceKeys.push(sourceKey);
                for (const value of op.tombstone.suppressedContent)
                  if (
                    included.has(
                      "content:" + (yield* contentJson(value).pipe(Effect.mapError(storageError))),
                    )
                  )
                    content.push(value);
                for (const exclusion of op.tombstone.sourceExclusions) {
                  const messageIds: M.MessageId[] = [];
                  for (const messageId of exclusion.messageIds)
                    if (
                      included.has(
                        "sourceExclusion:" +
                          (yield* exclusionJson({ ...exclusion, messageIds: [messageId] }).pipe(
                            Effect.mapError(storageError),
                          )),
                      )
                    )
                      messageIds.push(messageId);
                  if (messageIds.length) exclusions.push({ ...exclusion, messageIds });
                }
                return {
                  ...op.tombstone,
                  suppressedSourceKeys: sourceKeys,
                  suppressedContent: content,
                  sourceExclusions: exclusions,
                };
              });
            const excess = new Set([...unique.keys()].filter((key) => !selected.has(key)));
            if (excess.size) {
              const base = yield* fragment(selected);
              const hex = memoryOperationDigest(op);
              const extraId = M.MemoryOperationId.make(
                `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
              );
              const extra: Extract<M.MemoryOperation, { kind: "forget" }> = {
                ...op,
                operationId: extraId,
                expectedHeads: [],
                tombstone: { ...(yield* fragment(excess)), deleteOperationId: extraId },
              };
              const baseOp = { ...op, tombstone: base };
              const expansion = {
                requestDigest: decision.operationDigest,
                operationId: extraId,
                operationDigest: memoryOperationDigest(extra),
                status: "pending" as const,
              };
              const baseDecision = {
                ...decision,
                identity,
                operation: baseOp,
                operationDigest: memoryOperationDigest(baseOp),
                receipt: { ...decision.receipt, forgetExpansion: expansion },
              };
              const result = yield* withAdmission(
                {
                  operation: baseOp,
                  admission: decision.admission,
                  environmentId,
                  receipt: baseDecision.receipt,
                },
                store.apply(baseDecision),
              );
              const extraResult = yield* commit(
                {
                  operation: extra,
                  operationDigest: expansion.operationDigest,
                  admission: decision.admission,
                  receipt: {
                    operationId: extraId,
                    memoryId: op.memoryId,
                    outcome: "deleted",
                    revisionId: null,
                    pendingSync: true,
                  },
                },
                environmentId,
                permit,
              );
              return yield* store.settleForgetExpansion(op.memorySpaceId, {
                ...result,
                receipt: {
                  ...result.receipt,
                  forgetExpansion: {
                    ...expansion,
                    status:
                      extraResult.receipt.outcome === "rejected"
                        ? "rejected"
                        : "pendingSync" in extraResult.receipt && extraResult.receipt.pendingSync
                          ? "pending"
                          : "accepted",
                  },
                },
              });
            }
          }
          return yield* withAdmission(
            {
              operation: op,
              admission: decision.admission,
              environmentId,
              receipt: decision.receipt,
            },
            store.apply(
              decision.receipt.outcome === "rejected" ? decision : { ...decision, identity },
            ),
          ).pipe(
            Effect.catchTags({
              MemoryCapacityError: (error) => {
                if (
                  op.kind !== "forget" ||
                  !aggregate.tombstone ||
                  decision.admission.kind !== "localIntent"
                )
                  return Effect.fail(error);
                return Effect.gen(function* () {
                  const rejected = yield* store.apply({
                    ...decision,
                    receipt: {
                      ...decision.receipt,
                      operationId: op.operationId,
                      memoryId: op.memoryId,
                      outcome: "rejected",
                      revisionId: null,
                      pendingSync: false,
                      failureCode: "capacity_exceeded",
                      capacity: {
                        code: "capacity_exceeded",
                        dimension: yield* capacityDimensionDecode(error.dimension).pipe(
                          Effect.mapError(storageError),
                        ),
                        current: Math.max(0, error.current ?? error.limit),
                        limit: error.limit,
                        reclaimable: 0,
                      },
                    },
                  });
                  yield* store
                    .preserveForgetIntent({
                      memorySpaceId: op.memorySpaceId,
                      memoryId: op.memoryId,
                      operationId: op.operationId,
                      requestedAtUtc: op.tombstone.deletedAtUtc,
                      attempts: 0,
                      lastFailureCode: "capacity_exceeded",
                      operationDigest: decision.operationDigest,
                      submissionState: "rejected",
                    })
                    .pipe(
                      Effect.catchTags({
                        // The bounded rejection event is recoverable when an intent slot becomes free.
                        MemoryCapacityError: () => Effect.void,
                      }),
                    );
                  return rejected;
                });
              },
            }),
          );
        }),
      );
    },
  );
  const readStorageGrowth = Effect.fn("MemoryQuotaService.readStorageGrowth")(function* (
    environmentId: M.EnvironmentId,
  ) {
    const samples = yield* store.samples(environmentId);
    const current = samples.at(-1) ?? null;
    return yield* growthDecode({ current, deltas: storageDeltas(current, samples) }).pipe(
      Effect.mapError(storageError),
    );
  });
  const recordStorageSample = Effect.fn("MemoryQuotaService.recordStorageSample")(function* (
    environmentId: M.EnvironmentId,
    sharedMetrics?: { walBytes: number | null },
    alreadyMeasured?: Effect.Success<ReturnType<Store.MemoryStore["Service"]["measureAllocation"]>>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const logical = yield* store.logicalBytes;
    const measured = alreadyMeasured ?? (yield* store.measureAllocation());
    const sample = yield* sampleDecode({
      measuredAtUtc: DateTime.formatIso(DateTime.makeUnsafe(now)),
      utcDay: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(now)),
      status:
        measured.memoryBytes !== null &&
        sharedMetrics?.walBytes !== undefined &&
        sharedMetrics.walBytes !== null
          ? "available"
          : "partial",
      memoryLogicalBytes: logical,
      memoryAllocatedBytes: measured.memoryBytes,
      ftsAllocatedBytes: measured.ftsBytes,
      dbFileBytes: measured.dbFileBytes,
      walBytes: sharedMetrics?.walBytes ?? null,
      freelistBytes: measured.freelistBytes,
      tables: measured.tables,
    }).pipe(Effect.mapError(storageError));
    const accepted = yield* store.recordSample(environmentId, sample);
    const previous = yield* readStorageGrowth(environmentId);
    return accepted
      ? previous
      : { current: previous.current, deltas: storageDeltas(previous.current, [], true) };
  });
  const readStorageStatus: MemoryQuotaService["Service"]["readStorageStatus"] = Effect.fn(
    "MemoryQuotaService.readStorageStatus",
  )(function* (input) {
    return yield* store
      .transact(
        Effect.gen(function* () {
          const growth = yield* readStorageGrowth(input.environmentId);
          const fts = yield* store.ftsState(input.environmentId);
          const retention = yield* store.readHubRetentionTx(input.memorySpaceId);
          const counters = yield* store.counters(input.memorySpaceId);
          const hub = yield* store.readHubUsageTx(input.memorySpaceId);
          const lineageCounters = yield* store.counters("_hub_global");
          const inventory = yield* store.readHubInventoryTx(input.memorySpaceId);
          const limits: Partial<Record<M.MemoryCapacityDimension, number>> = {
            space_live_items: M.MEMORY_SPACE_MAX_LIVE_ITEMS,
            live_payload_bytes: M.MEMORY_LIVE_MAX_PAYLOAD_BYTES,
            history: M.MEMORY_HISTORY_MAX_PAYLOAD_BYTES,
            permanent_metadata: M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
            lifetime_ids: M.MEMORY_MAX_LIFETIME_IDS,
            receipts: M.MEMORY_DEDUP_MAX_RECEIPTS,
            import_source_items: M.MEMORY_IMPORT_MAX_SOURCE_ITEMS,
            import_lineage_bytes: M.MEMORY_IMPORT_LINEAGE_MAX_BYTES,
            log_tail_rows: M.MEMORY_LOG_MAX_TAIL_ROWS,
            log_tail_bytes: M.MEMORY_LOG_MAX_TAIL_BYTES,
            report_items: M.MEMORY_REPORT_MAX_PENDING_ITEMS,
            report_bytes: M.MEMORY_REPORT_MAX_PENDING_BYTES,
            work_items: M.MEMORY_WORK_MAX_PENDING_ITEMS,
            work_bytes: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
            checkpoint_staging: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
            checkpoint_handles: M.MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB,
            relay_hub: M.MEMORY_SOURCE_READ_MAX_PER_HUB,
            members: M.MEMORY_HUB_MAX_MEMBERS,
          };
          const quotas: M.MemoryStorageQuota[] = [];
          for (const dimension of M.MemoryCapacityDimension.literals) {
            const limit = limits[dimension];
            if (!limit) continue;
            const counter = counters
              .filter((c) => c.dimension === dimension)
              .reduce((sum, c) => sum + c.value, 0);
            const current =
              dimension === "import_lineage_bytes"
                ? (lineageCounters.find((counter) => counter.dimension === "import_lineage_bytes")
                    ?.value ?? 0)
                : dimension === "checkpoint_staging"
                  ? hub.stagingBytes
                  : dimension === "checkpoint_handles"
                    ? hub.liveHandles
                    : dimension === "relay_hub"
                      ? hub.liveSourceReads
                      : dimension === "members"
                        ? (hub.tables.find((table) => table.table === "memory_hub_members")
                            ?.rowCount ?? 0)
                        : dimension === "log_tail_rows"
                          ? counter + hub.tailRows
                          : dimension === "log_tail_bytes"
                            ? counter + hub.tailBytes
                            : dimension === "permanent_metadata"
                              ? counter + hub.permanentMetadataBytes
                              : counter;
            quotas.push({
              dimension,
              current,
              limit,
              reclaimable: inventory.reclaimable[dimension] ?? 0,
              reserved: inventory.reserved[dimension] ?? 0,
              warning: current >= limit ? "full" : current >= limit * 0.9 ? "warning" : "normal",
              blockedReasons: current >= limit ? ["capacity_exceeded"] : [],
            });
          }
          const sample = growth.current;
          const iso = (time: number | null) =>
            time === null ? null : DateTime.formatIso(DateTime.makeUnsafe(time));
          return yield* storageStatusDecode(
            {
              quotas,
              requiredCheckpointBoundBytes: hub.requiredCheckpointBoundBytes,
              lastSnapshotBytes: hub.lastSnapshotBytes,
              tables: [
                ...(sample?.tables ?? []).filter(
                  (table) => !hub.tables.some((h) => h.table === table.table),
                ),
                ...hub.tables.map((table) => {
                  const measured = sample?.tables.find((t) => t.table === table.table);
                  return measured
                    ? {
                        ...table,
                        allocatedBytes: measured.allocatedBytes,
                        allocationStatus: measured.allocationStatus,
                      }
                    : table;
                }),
              ],
              measuredAtUtc: sample?.measuredAtUtc ?? null,
              dbFileBytes: sample?.dbFileBytes ?? null,
              walBytes: sample?.walBytes ?? null,
              freelistBytes: sample?.freelistBytes ?? null,
              freelistRatio:
                sample?.dbFileBytes && sample.freelistBytes !== null
                  ? sample.freelistBytes / sample.dbFileBytes
                  : null,
              retentionFloor: retention.retentionFloor,
              checkpointSequence: retention.checkpointSequence,
              compaction: retention.compaction,
              ftsAdmission: {
                state: fts.state,
                changedAtUtc: iso(fts.changedAt),
                lastMeasuredAtUtc: iso(fts.measuredAt),
                allocatedBytes: fts.allocatedBytes,
                measurementStatus: fts.measurementStatus,
              },
              growth,
              warnings: [
                ...new Set([
                  ...retention.compaction.blockedReasons,
                  ...(fts.state === "braked" ? ["fts_braked" as const] : []),
                ]),
              ],
            },
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(storageError));
        }),
      )
      .pipe(
        Effect.catchTags({
          MemoryStoreConflict: (cause) =>
            Effect.fail(new Store.MemoryStorageError({ stage: "storage-status", cause })),
        }),
      );
  });
  const readUnboundStorageStatus: MemoryQuotaService["Service"]["readUnboundStorageStatus"] =
    Effect.fn("MemoryQuotaService.readUnboundStorageStatus")(function* (input) {
      return yield* store.transact(
        Effect.gen(function* () {
          const growth = yield* readStorageGrowth(input.environmentId);
          const fts = yield* store.ftsState(input.environmentId);
          // WP2 local drafts have no canonical hub inventory. The private input meter
          // tracks their serialized payload and outbox bytes transactionally.
          const counters = yield* store.counters(`_local:${input.environmentId}`);
          const value = (dimension: string) =>
            counters.find((counter) => counter.dimension === dimension && counter.scope_key === "")
              ?.value ?? 0;
          const localLimits = [
            ["work_items", value("processing_pending_sync"), M.MEMORY_WORK_MAX_PENDING_ITEMS],
            ["work_bytes", value("memory_input_bytes"), M.MEMORY_WORK_MAX_PAYLOAD_BYTES],
          ] as const;
          const quotas: M.MemoryStorageQuota[] = localLimits.map(([dimension, current, limit]) => ({
            dimension,
            current,
            limit,
            reclaimable: 0,
            reserved: 0,
            warning: current >= limit ? "full" : current >= limit * 0.9 ? "warning" : "normal",
            blockedReasons: current >= limit ? ["capacity_exceeded"] : [],
          }));
          const sample = growth.current;
          const iso = (time: number | null) =>
            time === null ? null : DateTime.formatIso(DateTime.makeUnsafe(time));
          return yield* storageStatusDecode(
            {
              quotas,
              tables: sample?.tables ?? [],
              measuredAtUtc: sample?.measuredAtUtc ?? null,
              dbFileBytes: sample?.dbFileBytes ?? null,
              walBytes: sample?.walBytes ?? null,
              freelistBytes: sample?.freelistBytes ?? null,
              freelistRatio:
                sample?.dbFileBytes && sample.freelistBytes !== null
                  ? sample.freelistBytes / sample.dbFileBytes
                  : null,
              retentionFloor: 0,
              checkpointSequence: 0,
              compaction: {
                lastRunAtUtc: null,
                removedRows: 0,
                reclaimedLogicalBytes: 0,
                reclaimableLogicalBytes: 0,
                blockedReasons: [],
              },
              ftsAdmission: {
                state: fts.state,
                changedAtUtc: iso(fts.changedAt),
                lastMeasuredAtUtc: iso(fts.measuredAt),
                allocatedBytes: fts.allocatedBytes,
                measurementStatus: fts.measurementStatus,
              },
              growth,
              warnings: fts.state === "braked" ? ["fts_braked"] : [],
            },
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(storageError));
        }),
      );
    });
  return MemoryQuotaService.of({
    readStorageStatus,
    readUnboundStorageStatus,
    withAdmission,
    commit,
    readStorageGrowth,
    recordStorageSample,
  });
});
export const layer = Layer.effect(MemoryQuotaService, make);
