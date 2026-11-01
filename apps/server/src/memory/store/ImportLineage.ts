import * as NodeUtil from "node:util";
import * as M from "@goat/contracts";
import type { ImportItem } from "../imports/MemoryImportTypes.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { Accounting } from "./Accounting.ts";
import type { CoreReads } from "./CoreReads.ts";
import {
  ImportBatchCodec,
  ImportCompletedNoopCodec,
  decodeAssertionKind,
  decodeMemoryId,
  importBatchCodec,
  importId,
  importItemCodec,
  importNoopResultCodec,
  lineageCodec,
  provenanceCodec,
  receiptCodec,
  scopeCodec,
  stored,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryCapacityError,
  MemoryStorageError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const noopResultRef = (
  b: typeof ImportCompletedNoopCodec.Type | typeof ImportBatchCodec.Type,
  json: string,
) =>
  hashText(
    importId(["goat/import-noop-result", "1", b.memorySpaceId, b.environmentId, b.sourceId, json]),
  );

export const makeImportLineage = (
  kernel: Pick<StoreKernel, "globalHubCounters" | "sql" | "withHubBudget">,
  coreReads: Pick<CoreReads, "readOperation">,
  accounting: Pick<Accounting, "settleForgetExpansion">,
) => {
  const { globalHubCounters, sql, withHubBudget } = kernel;
  const { readOperation } = coreReads;
  const { settleForgetExpansion } = accounting;
  // No pointer chains: the immutable object is addressed within its trusted origin.
  const shareImportNoopTx = Effect.fnUntraced(function* (batch: typeof ImportBatchCodec.Type) {
    const detailedJson = yield* importBatchCodec.encode(batch);
    if (
      batch.receipt.state !== "completed" ||
      batch.receipt.remaining !== 0 ||
      new TextEncoder().encode(batch.sessionId).length > 64 ||
      !batch.selections.every(
        (s) => s.result?.outcome === "noop" && s.observation !== undefined && s.settled === true,
      )
    )
      return { json: detailedJson, resultRef: null };
    const json = yield* importNoopResultCodec.encode({
      codecVersion: 1,
      items: batch.receipt.items,
    });
    const resultRef = noopResultRef(batch, json);
    const rows = yield* stored(
      "import-noop-existing",
      sql<{ result_json: string; codec_version: number }>`
      SELECT result_json,codec_version FROM memory_import_noop_results WHERE space=${batch.memorySpaceId}
      AND environment_id=${batch.environmentId} AND source_id=${batch.sourceId} AND result_ref=${resultRef}`,
    );
    if (rows[0] && (rows[0].result_json !== json || rows[0].codec_version !== 1))
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const compactJson = yield* importBatchCodec.encode({
      kind: "completed-noop-ref",
      codecVersion: 1,
      memorySpaceId: batch.memorySpaceId,
      environmentId: batch.environmentId,
      sourceId: batch.sourceId,
      operationId: batch.operationId,
      selectionDigest: batch.selectionDigest,
      sessionId: batch.sessionId,
      resultRef,
      sessionNewItems: batch.receipt.sessionNewItems,
      sessionBodyBytes: batch.receipt.sessionBodyBytes,
      createdAtUtc: batch.createdAtUtc,
    });
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const objectBytes = rows[0]
      ? 0
      : bytes(json) +
        bytes(resultRef) +
        bytes(batch.memorySpaceId) +
        bytes(batch.environmentId) +
        bytes(batch.sourceId) +
        8;
    // A legacy/late-settlement conversion must not need new admission. Very long
    // trusted origin labels can make the first object cost more than the detail.
    // Keep that detail intact; new-request admission still checks every dimension.
    if (bytes(compactJson) + bytes(resultRef) + objectBytes > bytes(detailedJson))
      return { json: detailedJson, resultRef: null };
    if (!rows[0])
      yield* stored(
        "import-noop-insert",
        sql`
      INSERT INTO memory_import_noop_results(space,environment_id,source_id,result_ref,codec_version,result_json)
      VALUES (${batch.memorySpaceId},${batch.environmentId},${batch.sourceId},${resultRef},1,${json})`,
      );
    return { resultRef, json: compactJson };
  });
  const readImportNoopResultTx = Effect.fnUntraced(function* (
    b: typeof ImportCompletedNoopCodec.Type,
  ) {
    const results = yield* stored(
      "import-noop-read",
      sql<{ result_json: string; codec_version: number }>`
          SELECT result_json,codec_version FROM memory_import_noop_results WHERE space=${b.memorySpaceId}
          AND environment_id=${b.environmentId} AND source_id=${b.sourceId} AND result_ref=${b.resultRef}`,
    );
    const row = results[0];
    if (!row || row.codec_version !== 1 || noopResultRef(b, row.result_json) !== b.resultRef)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const result = yield* importNoopResultCodec.decode(row.result_json, strict);
    return result;
  });
  const gcImportNoopTx = Effect.fnUntraced(function* (b: typeof ImportCompletedNoopCodec.Type) {
    yield* stored(
      "import-noop-gc",
      sql`DELETE FROM memory_import_noop_results
      WHERE space=${b.memorySpaceId} AND environment_id=${b.environmentId} AND source_id=${b.sourceId} AND result_ref=${b.resultRef}
      AND NOT EXISTS(SELECT 1 FROM memory_import_receipts r WHERE r.space=${b.memorySpaceId}
      AND r.environment_id=${b.environmentId} AND r.source_id=${b.sourceId} AND r.result_ref=${b.resultRef})`,
    );
  });
  // ACK and pull share this writer. Only the exact pending operation can move the
  // origin observation; late approvals still settle their own immutable batch result.
  const settleImportOperationTx = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    receipt: M.MemoryHubReceipt,
  ) {
    yield* Transaction;
    if (receipt.hubSequence === null && receipt.outcome !== "rejected") return;
    const links = yield* stored(
      "forget-fragment-links",
      sql<{
        receipt_json: string;
        operation_digest: string;
      }>`SELECT receipt_json,operation_digest FROM memory_events WHERE memory_space_id=${space}
       AND json_extract(receipt_json,'$.forgetExpansion.operationId')=${receipt.operationId}
      UNION SELECT receipt_json,operation_digest FROM memory_compact_receipts WHERE space=${space}
      AND json_extract(receipt_json,'$.forgetExpansion.operationId')=${receipt.operationId}`,
    );
    for (const link of links) {
      const parent = yield* receiptCodec.decode(link.receipt_json, strict);
      if (parent.forgetExpansion?.operationDigest !== receipt.operationDigest)
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      yield* settleForgetExpansion(space, {
        operationDigest: link.operation_digest,
        receipt: {
          ...parent,
          forgetExpansion: {
            ...parent.forgetExpansion,
            status: receipt.outcome === "rejected" ? "rejected" : "accepted",
          },
        },
      });
    }
    const issue: M.MemoryImportIssue =
      receipt.failureCode === "capacity_exceeded" ? "capacity_exceeded" : "source_changed";
    const batches = yield* stored(
      "import-settlement-batches",
      sql<{ receipt_id: string; completed_items_json: string }>`
      SELECT receipt_id,completed_items_json FROM memory_import_receipts WHERE space=${space} AND record_kind='batch'
      AND json_extract(completed_items_json,'$.kind')='detailed'
      AND EXISTS (SELECT 1 FROM json_each(completed_items_json,'$.selections') s
        WHERE (json_extract(s.value,'$.operationId')=${receipt.operationId}
          OR json_extract(s.value,'$.observation.operationId')=${receipt.operationId}
          OR json_extract(s.value,'$.result.revisionId') IN (SELECT revision_id FROM memory_revisions
            WHERE space=${space} AND operation_id=${receipt.operationId} AND memory_id=${receipt.memoryId}))
        AND json_type(s.value,'$.result')='object')`,
    );
    const operation = batches.length ? yield* readOperation(space, receipt.operationId) : undefined;
    const originalObservation =
      operation?.kind === "upsert" && operation.revision.provenance.importSource
        ? {
            sourceFingerprint: operation.revision.provenance.importSource.sourceFingerprint,
            contentFingerprint: operation.revision.provenance.importSource.contentFingerprint,
            revisionId: operation.revision.revisionId,
            operationId: operation.operationId,
          }
        : undefined;
    // Each batch freezes its own observation. A newer pending proposal cannot hide
    // an older approval, and hub order prevents accepted state from moving backward.
    const observations = new Map<string, NonNullable<ImportItem["pending"]>>();
    for (const row of batches) {
      const batch = yield* importBatchCodec.decode(row.completed_items_json, strict);
      if (batch.kind !== "detailed") continue;
      for (const selection of batch.selections) {
        const observation =
          selection.observation ??
          (selection.result?.revisionId === originalObservation?.revisionId
            ? originalObservation
            : undefined);
        if (observation?.operationId === receipt.operationId) {
          observations.set(
            importId([
              "item",
              space,
              batch.environmentId,
              batch.sourceId,
              selection.selector.sourceItemKey,
            ]),
            observation,
          );
        }
      }
    }
    const rows = yield* stored(
      "import-settlement-items",
      sql<{
        receipt_id: string;
        registration_json: string;
      }>`SELECT receipt_id,registration_json FROM memory_import_receipts
      WHERE space=${space} AND record_kind='item' AND (json_extract(registration_json,'$.pending.operationId')=${receipt.operationId}
        OR receipt_id IN (SELECT value FROM json_each(${importId([...observations.keys()])})))`,
    );
    for (const row of rows) {
      const item = yield* importItemCodec.decode(row.registration_json, strict);
      const observation = observations.get(row.receipt_id) ?? item.pending;
      if (!observation || observation.operationId !== receipt.operationId) continue;
      if (item.memoryId !== receipt.memoryId)
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const latest = item.pending?.operationId === receipt.operationId;
      const acceptedRows = item.accepted
        ? yield* stored(
            "import-accepted-sequence",
            sql<{
              sequence: number | null;
            }>`SELECT json_extract(receipt_json,'$.hubSequence') AS sequence FROM memory_events
        WHERE memory_space_id=${space} AND operation_id=${item.accepted.operationId}
        UNION ALL SELECT hub_sequence FROM memory_compact_receipts WHERE space=${space} AND operation_id=${item.accepted.operationId}
        UNION ALL SELECT json_extract(record_json,'$.receipt.hubSequence') FROM memory_import_keys
        WHERE space=${space} AND key_kind='hubReceipt' AND key=${item.accepted.operationId}`,
          )
        : [];
      const acceptedSequence = acceptedRows.reduce<number | null>(
        (max, row) => (row.sequence === null ? max : Math.max(max ?? 0, row.sequence)),
        null,
      );
      const promote =
        receipt.outcome !== "rejected" &&
        receipt.hubSequence !== null &&
        (acceptedSequence === null ||
          acceptedSequence === undefined ||
          receipt.hubSequence > acceptedSequence);
      const next = {
        ...item,
        accepted: promote ? observation : item.accepted,
        pending: latest ? null : item.pending,
        rejected: latest
          ? receipt.outcome === "rejected"
            ? { sourceFingerprint: observation.sourceFingerprint, issue }
            : null
          : item.rejected,
        outcome: latest
          ? receipt.outcome === "rejected"
            ? ("rejected" as const)
            : receipt.outcome === "conflicted"
              ? ("conflicted" as const)
              : item.outcome
          : item.outcome,
      };
      if (NodeUtil.isDeepStrictEqual(item, next)) continue;
      yield* stored(
        "import-settlement-item",
        sql`UPDATE memory_import_receipts SET registration_json=${yield* importItemCodec.encode(next)},outcome=${next.outcome} WHERE receipt_id=${row.receipt_id}`,
      );
    }
    for (const row of batches) {
      const batch = yield* importBatchCodec.decode(row.completed_items_json, strict);
      if (batch.kind !== "detailed") continue;
      const selections = batch.selections.map((s) =>
        ((s.observation?.operationId ?? s.operationId) !== receipt.operationId &&
          (!originalObservation || s.result?.revisionId !== originalObservation.revisionId)) ||
        !s.result
          ? s
          : {
              ...s,
              settled: true,
              result:
                receipt.outcome === "rejected"
                  ? {
                      sourceItemKey: s.selector.sourceItemKey,
                      outcome: "rejected" as const,
                      issue,
                      ...(receipt.capacity ? { capacity: receipt.capacity } : {}),
                      memoryId: null,
                      revisionId: null,
                    }
                  : receipt.outcome === "conflicted"
                    ? { ...s.result, outcome: "conflicted" as const }
                    : s.result,
            },
      );
      const next = {
        ...batch,
        selections,
        receipt: {
          ...batch.receipt,
          items: selections.flatMap((s) => (s.result ? [s.result] : [])),
        },
      };
      if (NodeUtil.isDeepStrictEqual(batch, next)) continue;
      const shared = yield* shareImportNoopTx(next);
      yield* stored(
        "import-settlement-batch",
        sql`UPDATE memory_import_receipts SET completed_items_json=${shared.json},result_ref=${shared.resultRef} WHERE receipt_id=${row.receipt_id}`,
      );
    }
  });
  const retireImportBatchesTx = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    now: number,
    limit: number,
    operationId: M.MemoryOperationId | null = null,
  ) {
    yield* Transaction;
    const rows = yield* stored(
      "import-batch-expired",
      sql<{
        receipt_id: string;
        completed_items_json: string;
        environment_id: string;
        source_id: string;
        batch_operation_id: string;
        request_digest: string;
        result_ref: string | null;
        observed_at_utc: string;
      }>`
      SELECT receipt_id,completed_items_json,environment_id,source_id,batch_operation_id,request_digest,result_ref,observed_at_utc FROM memory_import_receipts b WHERE space=${space} AND record_kind='batch'
      AND json_extract(completed_items_json,'$.kind') IN ('detailed','completed-noop-ref')
      AND (${operationId} IS NULL OR batch_operation_id=${operationId})
      AND observed_at_utc<=${DateTime.formatIso(DateTime.makeUnsafe(now - M.MEMORY_IMPORT_BATCH_RETENTION_MS))}
      AND NOT EXISTS (SELECT 1 FROM json_each(b.completed_items_json,'$.selections') s
        WHERE json_type(s.value,'$.observation')='object' AND coalesce(json_extract(s.value,'$.settled'),0)=0)
      AND NOT EXISTS (SELECT 1 FROM json_each(b.completed_items_json,'$.selections') s JOIN memory_import_receipts i
        ON i.space=b.space AND i.environment_id=b.environment_id AND i.record_kind='item'
        WHERE (json_extract(i.registration_json,'$.pending.operationId')=coalesce(json_extract(s.value,'$.observation.operationId'),json_extract(s.value,'$.operationId'))
          OR json_extract(i.registration_json,'$.pending.revisionId')=json_extract(s.value,'$.result.revisionId')))
      AND NOT EXISTS (SELECT 1 FROM json_each(b.completed_items_json,'$.selections') s JOIN memory_outbox o ON o.space=b.space
        WHERE o.status IN ('pending','running','retry') AND (json_extract(o.metadata_json,'$.operationId')=coalesce(json_extract(s.value,'$.observation.operationId'),json_extract(s.value,'$.operationId'))
          OR json_extract(o.metadata_json,'$.revision.revisionId')=json_extract(s.value,'$.result.revisionId')))
      ORDER BY observed_at_utc,receipt_id LIMIT ${limit}`,
    );
    for (const row of rows) {
      const batch = yield* importBatchCodec.decode(row.completed_items_json, strict);
      if (
        batch.kind === "retired" ||
        batch.memorySpaceId !== space ||
        batch.environmentId !== row.environment_id ||
        batch.sourceId !== row.source_id ||
        batch.operationId !== row.batch_operation_id ||
        batch.createdAtUtc !== row.observed_at_utc ||
        batch.selectionDigest !== row.request_digest ||
        row.result_ref !== (batch.kind === "completed-noop-ref" ? batch.resultRef : null)
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (batch.kind === "completed-noop-ref") yield* readImportNoopResultTx(batch);
      yield* stored(
        "import-batch-retire",
        sql`UPDATE memory_import_receipts SET completed_items_json=${yield* importBatchCodec.encode({ kind: "retired", codecVersion: 1, selectionDigest: batch.selectionDigest })},result_ref=NULL WHERE receipt_id=${row.receipt_id}`,
      );
      if (batch.kind === "completed-noop-ref") yield* gcImportNoopTx(batch);
    }
    return rows.length;
  });
  // Pre-release databases with approved import provenance but no lifetime evidence must
  // be explicitly rebuilt by their operator. Never infer an empty ledger is complete.
  const requireImportLineageCompleteTx = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    yield* Transaction;
    const rows = yield* stored(
      "import-lineage-completeness",
      sql<{
        memory_id: string;
        provenance_json: string;
        scope_json: string;
        assertion_kind: string;
      }>`SELECT r.memory_id,r.provenance_json,r.scope_json,r.assertion_kind FROM memory_revisions r
      WHERE r.space=${space} AND json_type(r.provenance_json,'$.importSource')='object'
      AND (EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_space_id=r.space AND e.operation_id=r.operation_id
        AND json_extract(e.receipt_json,'$.memoryId')=r.memory_id AND json_extract(e.receipt_json,'$.operationId')=r.operation_id
        AND json_extract(e.receipt_json,'$.hubSequence') IS NOT NULL AND json_extract(e.receipt_json,'$.outcome')!='rejected')
      OR EXISTS (SELECT 1 FROM memory_compact_receipts c WHERE c.space=r.space AND c.operation_id=r.operation_id
        AND json_extract(c.receipt_json,'$.memoryId')=r.memory_id AND json_extract(c.receipt_json,'$.operationId')=r.operation_id
        AND c.hub_sequence IS NOT NULL AND json_extract(c.receipt_json,'$.outcome')!='rejected')
      OR EXISTS (SELECT 1 FROM memory_import_keys k WHERE k.space=r.space AND k.key_kind='hubReceipt' AND k.key=r.operation_id
        AND k.memory_id=r.memory_id AND json_extract(k.record_json,'$.receipt.memoryId')=r.memory_id
        AND json_extract(k.record_json,'$.receipt.operationId')=r.operation_id
        AND json_extract(k.record_json,'$.receipt.hubSequence') IS NOT NULL
        AND json_extract(k.record_json,'$.receipt.outcome')!='rejected'))`,
    );
    const retained = rows.length
      ? yield* stored(
          "import-lineage-required",
          sql<{
            memory_id: string;
            kind: string;
            key: string;
          }>`SELECT memory_id,kind,key FROM memory_import_lineage WHERE space=${space}`,
        )
      : [];
    const keys = new Set(retained.map((r) => importId([r.memory_id, r.kind, r.key])));
    for (const row of rows) {
      const provenance = yield* provenanceCodec.decode(row.provenance_json, strict);
      const scope = yield* scopeCodec.decode(row.scope_json, strict);
      const source = provenance.importSource!;
      const base = {
        memorySpaceId: space,
        memoryId: yield* stored("lineage-memory-id", decodeMemoryId(row.memory_id)),
      };
      const assertionKind = yield* stored(
        "lineage-assertion",
        decodeAssertionKind(row.assertion_kind),
      );
      const records: M.MemoryImportLineageRecord[] = [
        ...[
          {
            environmentId: provenance.environmentId,
            sourceId: source.sourceId,
            sourceItemKey: source.sourceItemKey,
          },
          ...source.sourceAliases,
        ].map((sourceKey) => ({ ...base, kind: "sourceKey" as const, sourceKey })),
        ...[source.contentFingerprint, ...source.acceptedContentFingerprints].map(
          (contentFingerprint) => ({
            ...base,
            kind: "content" as const,
            content: { scope, assertionKind, contentFingerprint },
          }),
        ),
      ];
      for (const record of records) {
        const key = M.memoryImportLineageRecordKey({
          ...record,
          memoryId: M.MemoryId.make("00000000-0000-4000-8000-000000000000"),
        });
        if (!keys.has(importId([base.memoryId, record.kind, key])))
          return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
      }
    }
  });
  const persistImportLineageTx = Effect.fnUntraced(function* (
    input: ReadonlyArray<M.MemoryImportLineageRecord>,
  ) {
    yield* Transaction;
    const changed: M.MemoryImportLineageRecord[] = [];
    for (const value of input) {
      const json = yield* lineageCodec.encode(value);
      const record = yield* lineageCodec.decode(json, strict);
      const lookup = M.memoryImportLineageRecordKey({
        ...record,
        memoryId: M.MemoryId.make("00000000-0000-4000-8000-000000000000"),
      });
      const identity = yield* stored(
        "lineage-identity",
        sql`
        SELECT 1 FROM memory_identity_ledger WHERE space=${record.memorySpaceId} AND memory_id=${record.memoryId}`,
      );
      if (!identity.length) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const inserted = yield* stored(
        "lineage-union",
        sql`
        INSERT INTO memory_import_lineage(space,memory_id,kind,key,record_json)
        VALUES (${record.memorySpaceId},${record.memoryId},${record.kind},${lookup},${json})
        ON CONFLICT(space,memory_id,kind,key) DO NOTHING RETURNING memory_id`,
      );
      if (inserted.length) changed.push(record);
    }
    return changed;
  });
  const unionImportLineageTx: MemoryStoreShape["unionImportLineageTx"] = Effect.fn(
    "MemoryStore.unionImportLineageTx",
  )(function* (input, admission) {
    if (admission.kind === "approvedReplica") {
      yield* persistImportLineageTx(input);
      return;
    }
    yield* withHubBudget(
      Effect.gen(function* () {
        const changed = yield* persistImportLineageTx(input);
        for (const record of changed) {
          const rows = yield* stored(
            "lineage-count",
            sql<{ count: number }>`
          SELECT count(*) AS count FROM memory_import_lineage
          WHERE space=${record.memorySpaceId} AND memory_id=${record.memoryId}`,
          );
          if (rows[0]!.count > M.MEMORY_IMPORT_LINEAGE_MAX_RECORDS_PER_MEMORY)
            return yield* new MemoryCapacityError({
              dimension: "import_lineage_records",
              current: rows[0]!.count,
              limit: M.MEMORY_IMPORT_LINEAGE_MAX_RECORDS_PER_MEMORY,
            });
        }
        if (!changed.length) return;
        const bytes = (yield* globalHubCounters()).find(
          (row) => row.dimension === "import_lineage_bytes",
        )?.value;
        if (bytes === undefined)
          return yield* new MemoryStorageError({ stage: "lineage-counter", cause: undefined });
        if (bytes > M.MEMORY_IMPORT_LINEAGE_MAX_BYTES)
          return yield* new MemoryCapacityError({
            dimension: "import_lineage_bytes",
            current: bytes,
            limit: M.MEMORY_IMPORT_LINEAGE_MAX_BYTES,
          });
      }),
    );
  });
  return {
    shareImportNoopTx,
    readImportNoopResultTx,
    settleImportOperationTx,
    retireImportBatchesTx,
    requireImportLineageCompleteTx,
    persistImportLineageTx,
    unionImportLineageTx,
  };
};

export type ImportLineage = ReturnType<typeof makeImportLineage>;
