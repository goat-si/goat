import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { encodeCompactReceipt } from "./CompactReceipt.ts";
import type { CoreReads } from "./CoreReads.ts";
import type { RevertResults } from "./RevertResults.ts";
import {
  compactCodec,
  environmentOrdinalCodec,
  exclusionsCodec,
  hubReceiptCodec,
  lineageCodec,
  lineageForRevision,
  receiptCodec,
  scopeKey,
  stored,
  suppressionCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryCapacityError,
  MemoryStoreConflict,
  StoredReceipt,
  hasSourceEvidence,
  strict,
} from "./StoreModel.ts";
import type { MemoryAdmissionContext, MemoryAggregate, MemoryQuotaCharge } from "./StoreModel.ts";

export const makeAccounting = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "loadAggregate" | "readImportLineage" | "receipt">,
  revertResults: Pick<RevertResults, "settleRevertResultTx">,
) => {
  const { sql, transact } = kernel;
  const { loadAggregate, readImportLineage, receipt } = coreReads;
  const { settleRevertResultTx } = revertResults;
  const reserve = Effect.fn("MemoryStore.reserve")(function* (
    context: MemoryAdmissionContext,
    charges: ReadonlyArray<MemoryQuotaCharge>,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const admitted: Array<{ charge: MemoryQuotaCharge; value: number }> = [];
        const pending = new Map<string, number>();
        for (const charge of charges) {
          const rows = yield* stored(
            "quota",
            sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space=${charge.space} AND dimension=${charge.dimension} AND scope_key=${charge.scopeKey}`,
          );
          const key = `${charge.space}:${charge.dimension}:${charge.scopeKey}`;
          const value = (charge.current ?? pending.get(key) ?? rows[0]?.value ?? 0) + charge.delta;
          if (
            value < 0 ||
            (context.kind !== "approvedReplica" && charge.delta > 0 && value > charge.limit)
          )
            return yield* new MemoryCapacityError({
              dimension: charge.dimension,
              limit: charge.limit,
              current: value,
            });
          admitted.push({ charge, value });
          pending.set(key, value);
        }
        for (const { charge, value } of admitted) {
          yield* stored(
            "quota-write",
            sql`INSERT INTO memory_quota_counters (space,dimension,scope_key,value) VALUES (${charge.space},${charge.dimension},${charge.scopeKey},${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
          );
        }
      }),
    );
  });
  const settleForgetExpansion = Effect.fn("MemoryStore.settleForgetExpansion")(function* (
    space: M.MemorySpaceId,
    result: StoredReceipt,
  ) {
    const original = yield* receipt(space, result.receipt.operationId);
    if (!original || original.operationDigest !== result.operationDigest)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const prior = original.receipt.forgetExpansion;
    const next = result.receipt.forgetExpansion;
    if (
      prior &&
      (!next ||
        prior.operationId !== next.operationId ||
        prior.operationDigest !== next.operationDigest ||
        prior.requestDigest !== next.requestDigest)
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    yield* stored(
      "forget-expansion-result",
      sql`UPDATE memory_events SET receipt_json=${yield* receiptCodec.encode(result.receipt)} WHERE memory_space_id=${space} AND operation_id=${result.receipt.operationId}`,
    );
    const compact = yield* stored(
      "forget-expansion-compact",
      sql<{
        compact_json: string;
      }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${result.receipt.operationId}`,
    );
    if (compact[0]) {
      const record = yield* compactCodec.decode(compact[0].compact_json, strict);
      const receipt = yield* hubReceiptCodec.decode(
        yield* receiptCodec.encode(result.receipt),
        strict,
      );
      yield* persistCompactReceipt({ ...record, receipt });
    }
    return result;
  });
  const readForgetReservation = Effect.fn("MemoryStore.readForgetReservation")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    const rows = yield* stored(
      "forget-reservation",
      sql<{
        bytes: number;
        keys: number;
      }>`SELECT max(0,reserve_bytes-${M.MEMORY_IDENTITY_CORE_MAX_BYTES}) AS bytes,reserve_keys AS keys FROM memory_identity_ledger WHERE space=${space} AND memory_id=${id}`,
    );
    return rows[0] ?? { bytes: 0, keys: 0 };
  });
  const reservationForRevisions = Effect.fn("MemoryStore.reservationForRevisions")(function* (
    op: Pick<M.MemoryOperation, "memorySpaceId" | "memoryId" | "operationId">,
    revisions: MemoryAggregate["revisions"],
    includeRevisionLineage = true,
  ) {
    const records = new Map<string, M.MemorySuppressionRecord>();
    for (const { revision, payload } of revisions) {
      const { sourceThread, sourceWatermark } = revision.provenance;
      if (!sourceThread || !sourceWatermark) continue;
      for (const messageId of new Set((payload?.evidence ?? []).flatMap((e) => e.messageIds))) {
        const exclusion = { sourceThread, sourceWatermark, messageIds: [messageId] };
        const key = yield* exclusionsCodec.encode([exclusion]);
        records.set(key, {
          memorySpaceId: op.memorySpaceId,
          memoryId: op.memoryId,
          deleteOperationId: op.operationId,
          kind: "sourceExclusion",
          exclusion,
        });
      }
    }
    let bytes = 0;
    for (const record of records.values())
      bytes += new TextEncoder().encode(yield* suppressionCodec.encode(record)).length;
    const lineage = new Map<string, M.MemoryImportLineageRecord>();
    for (const record of [
      ...(yield* readImportLineage(op.memorySpaceId, op.memoryId)),
      ...(includeRevisionLineage
        ? revisions.flatMap(({ revision }) => lineageForRevision(revision))
        : []),
    ])
      lineage.set(M.memoryImportLineageRecordKey(record), record);
    let lineageBytes = 0;
    for (const record of lineage.values())
      lineageBytes += new TextEncoder().encode(yield* lineageCodec.encode(record)).length + 64;
    return {
      bytes: Math.max(M.MEMORY_PAYLOAD_MAX_UTF8_BYTES, bytes) + lineageBytes,
      keys: records.size + lineage.size,
    };
  });
  const firstForgetReservation = Effect.fn("MemoryStore.firstForgetReservation")(function* (
    op: M.MemoryOperation,
  ) {
    // Only source-attributed revisions contribute payload evidence to the reservation.
    const current = yield* loadAggregate(
      op.memorySpaceId,
      op.memoryId,
      {
        when: hasSourceEvidence,
      },
      { importLineage: true },
    );
    return yield* reservationForRevisions(op, [
      ...current.revisions,
      ...(op.kind === "forget" ? [] : [{ revision: op.revision, payload: op.payload }]),
    ]);
  });
  const usage = Effect.fn("MemoryStore.usage")(function* (
    space: M.MemorySpaceId,
    scope: M.MemoryScope,
  ) {
    const rows = yield* stored(
      "usage-counters",
      sql<{ space: string; dimension: string; scope_key: string; value: number }>`
      SELECT space,dimension,scope_key,value FROM memory_quota_counters
      WHERE (space=${space} OR space='_usage_environment')
        AND dimension IN ('usage_items','usage_summaries','usage_live_bytes','usage_payload_bytes','usage_identities','usage_identity_bytes','usage_reserved_keys','usage_reserved_receipts','usage_keys','usage_key_bytes','usage_lineage_bytes','usage_work_items','usage_work_bytes','usage_log_rows','usage_log_bytes','usage_receipts','usage_receipt_bytes') AND scope_key IN ('',${scopeKey(scope)})`,
    );
    const get = (dimension: string, environment = false, scoped = false) =>
      rows.find(
        (r) =>
          r.space === (environment ? "_usage_environment" : space) &&
          r.dimension === `usage_${dimension}` &&
          r.scope_key === (scoped ? scopeKey(scope) : ""),
      )?.value ?? 0;
    const extra = yield* stored(
      "usage-existing-counters",
      sql<{ space: string; dimension: string; value: number }>`
      SELECT space,dimension,value FROM memory_quota_counters WHERE scope_key='' AND
      ((space=${space} AND dimension IN ('import_metadata','report_items','report_bytes')) OR
       (space='_hub_global' AND dimension='hub_private_metadata'))`,
    );
    const existing = (dimension: string) =>
      extra.find((r) => r.dimension === dimension)?.value ?? 0;
    const permanent = (environment = false) =>
      get("identity_bytes", environment) +
      get("key_bytes", environment) +
      get("lineage_bytes", environment) +
      get("receipt_bytes", environment) +
      get("reserved_receipts", environment) * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES;
    return {
      scopeItems: get("items", false, true),
      scopeSummaries: get("summaries", false, true),
      scopeExplicit: get("items", false, true) - get("summaries", false, true),
      environmentItems: get("items", true),
      environmentLiveBytes: get("live_bytes", true),
      environmentHistoryBytes: get("payload_bytes", true) - get("live_bytes", true),
      environmentLifetimeIds: get("identities", true),
      environmentReceipts: get("receipts", true) + get("reserved_receipts", true),
      environmentPermanentBytes: permanent(true) + existing("hub_private_metadata"),
      spaceItems: get("items"),
      lifetimeIds: get("identities"),
      permanentBytes: permanent() + existing("import_metadata"),
      receipts: get("receipts") + get("reserved_receipts"),
      liveBytes: get("live_bytes"),
      historyBytes: get("payload_bytes") - get("live_bytes"),
      logicalBytes:
        existing("import_metadata") +
        get("payload_bytes") +
        get("log_bytes") +
        get("key_bytes") +
        get("lineage_bytes"),
      keys: get("keys") + get("reserved_keys"),
      workItems: get("work_items"),
      workBytes: get("work_bytes"),
      reportItems: existing("report_items"),
      reportBytes: existing("report_bytes"),
      logRows: get("log_rows"),
      logBytes: get("log_bytes"),
    };
  });
  const persistCompactReceipt = Effect.fn("MemoryStore.persistCompactReceipt")(function* (
    input: M.MemoryCompactReceipt,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const old = yield* receipt(input.memorySpaceId, input.receipt.operationId);
        const json = yield* compactCodec.encode({
          ...input,
          receipt: {
            ...input.receipt,
            ...(!input.receipt.forgetExpansion && old?.receipt.forgetExpansion
              ? { forgetExpansion: old.receipt.forgetExpansion }
              : {}),
            ...(old?.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}),
          },
        });
        const record = yield* compactCodec.decode(json, strict);
        if (record.operationKind === "revert" && record.revertsResolutionId)
          yield* settleRevertResultTx(
            record.memorySpaceId,
            record.receipt.memoryId,
            record.revertsResolutionId,
            record.receipt,
            record.revisionId,
          );
        const existing = yield* stored(
          "compact-existing",
          sql<{
            compact_json: string;
          }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${record.memorySpaceId} AND operation_id=${record.receipt.operationId}`,
        );
        if (existing[0]) {
          const prior = yield* compactCodec.decode(existing[0].compact_json, strict);
          const preserved = {
            ...prior,
            receipt: {
              ...prior.receipt,
              ...(record.receipt.forgetExpansion
                ? { forgetExpansion: record.receipt.forgetExpansion }
                : {}),
              ...(record.receipt.forgetRetryOf
                ? { forgetRetryOf: record.receipt.forgetRetryOf }
                : {}),
            },
          };
          if ((yield* compactCodec.encode(preserved)) !== json)
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        }
        if (
          old &&
          (old.operationDigest !== record.receipt.operationDigest ||
            ("hubSequence" in old.receipt &&
              old.receipt.hubSequence !== record.receipt.hubSequence))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const ordinals = new Map<M.EnvironmentId, number>();
        for (const environment of [
          record.originEnvironmentId,
          ...(record.reportGuard ? [record.reportGuard.resolvingEnvironmentId] : []),
        ]) {
          const existing = yield* stored(
            "compact-environment",
            sql<{
              record_json: string;
            }>`SELECT record_json FROM memory_import_keys WHERE space=${record.memorySpaceId} AND key_kind='environment' AND key=${environment}`,
          );
          let ordinal: number;
          if (existing[0])
            ordinal = yield* environmentOrdinalCodec.decode(existing[0].record_json, strict);
          else {
            const counts = yield* stored(
              "compact-environment-count",
              sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_import_keys WHERE space=${record.memorySpaceId} AND key_kind='environment'`,
            );
            ordinal = counts[0]!.count + 1;
            yield* stored(
              "compact-environment-write",
              sql`INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) VALUES (${record.memorySpaceId},'environment',${environment},${record.receipt.memoryId},${yield* environmentOrdinalCodec.encode(ordinal)})`,
            );
          }
          ordinals.set(environment, ordinal);
        }
        const binary = encodeCompactReceipt(record, (id) => ordinals.get(id)!);
        if (binary.length > M.MEMORY_COMPACT_RECEIPT_MAX_BYTES)
          return yield* new MemoryStoreConflict({ code: "payload_too_large" });
        yield* stored(
          "compact-receipt-write",
          sql`INSERT INTO memory_compact_receipts (space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob,report_key) VALUES (${record.memorySpaceId},${record.receipt.operationId},${record.receipt.operationDigest},${record.receipt.hubSequence!},${yield* receiptCodec.encode(record.receipt)},${json},${binary},${record.reportGuard?.reportId ?? null}) ON CONFLICT(space,operation_id) DO UPDATE SET receipt_json=excluded.receipt_json,compact_json=excluded.compact_json,compact_blob=excluded.compact_blob`,
        );
      }),
    );
  });
  return {
    reserve,
    settleForgetExpansion,
    readForgetReservation,
    reservationForRevisions,
    firstForgetReservation,
    usage,
    persistCompactReceipt,
  };
};

export type Accounting = ReturnType<typeof makeAccounting>;
