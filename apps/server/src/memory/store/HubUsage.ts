import { checkpointBound } from "../MemoryCheckpointBound.ts";
import { refreshCheckpointAccounting } from "../MemoryCheckpointAccounting.ts";
import * as M from "@goat/contracts";
import { reportMetadataBytes } from "../MemoryReportAccounting.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { adminCodec, adminReplayJson, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryCapacityError, Transaction, strict } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

export const makeHubUsage = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  const readHubUsageTx: MemoryStoreShape["readHubUsageTx"] = Effect.fn(
    "MemoryStore.readHubUsageTx",
  )(function* (space) {
    yield* Transaction;
    yield* stored(
      "checkpoint-accounting",
      refreshCheckpointAccounting().pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
    const rows = yield* stored(
      "hub-usage",
      sql<{
        tail_rows: number;
        tail_bytes: number;
        members: number;
        relay: number;
        source_bytes: number;
        checkpoint_bytes: number;
        last_snapshot_bytes: number;
        consumed_bytes: number;
        pinned_bytes: number;
        metadata_bytes: number;
      }>`SELECT
      (SELECT count(*) FROM memory_hub_operations WHERE space=${space}) AS tail_rows,
      (SELECT coalesce(sum(length(CAST(entry_json AS BLOB))),0) FROM memory_hub_operations WHERE space=${space}) AS tail_bytes,
      (SELECT count(*) FROM memory_hub_members WHERE space=${space} AND status='active') AS members,
      (SELECT count(*) FROM memory_hub_source_reads WHERE space=${space} AND state!='expired') AS relay,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p JOIN memory_hub_source_reads r ON r.space=p.space AND r.payload_ref=p.payload_ref WHERE r.space=${space}) AS source_bytes,
      (SELECT coalesce(checkpoint_bytes,0) FROM memory_hub_retention WHERE space=${space}) AS checkpoint_bytes,
      (SELECT coalesce(last_snapshot_bytes,0) FROM memory_hub_retention WHERE space=${space}) AS last_snapshot_bytes,
      (SELECT CASE WHEN r.checkpoint_id IS NOT r.reserved_snapshot_id AND NOT EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE json_extract(h.value,'$.checkpointId')=r.reserved_snapshot_id) AND r.snapshot_generation=coalesce((SELECT value FROM memory_quota_counters WHERE space=r.space AND dimension='hub_snapshot_generation' AND scope_key=''),0) AND EXISTS(SELECT 1 FROM memory_inbox_pending p WHERE p.space=r.space AND p.reason='hub_snapshot' AND p.checkpoint_id='hub:'||r.reserved_snapshot_id) THEN min(r.last_snapshot_bytes,r.published_pinned_bytes) ELSE 0 END FROM memory_hub_retention r WHERE r.space=${space}) AS consumed_bytes,
      (SELECT coalesce(published_pinned_bytes,0) FROM memory_hub_retention WHERE space=${space}) AS pinned_bytes,
      (SELECT coalesce(sum(length(CAST(credential_digest AS BLOB))+length(CAST(environment AS BLOB))+32),0) FROM memory_hub_members WHERE space=${space})+
      (SELECT coalesce(sum(length(CAST(lease_json AS BLOB))+32),0) FROM memory_hub_leases WHERE space=${space}) AS metadata_bytes`,
    );
    const row = rows[0]!;
    const inputs = yield* stored(
      "hub-snapshot-input-counters",
      sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows')`,
    );
    const inputCounters = new Map(inputs.map((r) => [r.dimension, r.value]));
    const requiredCheckpointBoundBytes = checkpointBound(
      inputCounters.get("hub_snapshot_bytes") ?? 0,
      inputCounters.get("hub_snapshot_rows") ?? 0,
    );
    const usage = yield* usageForHub(space);
    const specifications = [
      ["memory_import_lineage", "length(CAST(record_json AS BLOB))"],
      ["memory_hub_operations", "length(CAST(entry_json AS BLOB))"],
      [
        "memory_hub_members",
        "length(CAST(space AS BLOB))+length(CAST(environment AS BLOB))+length(CAST(credential_digest AS BLOB))+length(CAST(credential_version AS TEXT))+length(CAST(status AS BLOB))+coalesce(length(CAST(joined_at AS TEXT)),0)",
      ],
      [
        "memory_hub_leases",
        "length(CAST(space AS BLOB))+length(CAST(memory_id AS BLOB))+length(CAST(highest_token AS TEXT))+coalesce(length(CAST(lease_json AS BLOB)),0)",
      ],
      [
        "memory_hub_source_reads",
        "length(CAST(locator_json AS BLOB))+length(CAST(request_digest AS BLOB))+coalesce(length(CAST(response_digest AS BLOB)),0)",
      ],
      [
        "memory_hub_retention",
        "coalesce(length(CAST(boundary_json AS BLOB)),0)+length(CAST(handles_json AS BLOB))+coalesce(length(CAST(compaction_json AS BLOB)),0)",
      ],
    ] as const;
    const tables: M.MemoryStorageTableUsage[] = [];
    for (const [table, expression] of specifications) {
      // Both identifiers and expressions come only from the closed internal inventory above.
      const counts = yield* stored(
        "hub-table-logical",
        sql.unsafe<{ rows: number; bytes: number }>(
          `SELECT count(*) AS rows,coalesce(sum(${expression}),0) AS bytes FROM ${table} WHERE space=?`,
          [space],
        ),
      );
      tables.push({
        table,
        rowCount: counts[0]!.rows,
        logicalBytes: counts[0]!.bytes,
        allocatedBytes: null,
        allocationStatus: "unavailable",
      });
    }
    tables.push({
      table: "memory_report_outbox",
      rowCount: usage.reportRows,
      logicalBytes: usage.reportMetadataBytes,
      allocatedBytes: null,
      allocationStatus: "unavailable",
    });
    return {
      tables,
      tailRows: row.tail_rows,
      tailBytes: row.tail_bytes,
      permanentMetadataBytes: tables
        .filter(
          (table) =>
            table.table === "memory_report_outbox" ||
            table.table === "memory_import_lineage" ||
            table.table === "memory_hub_members" ||
            table.table === "memory_hub_leases" ||
            table.table === "memory_hub_retention",
        )
        .reduce((sum, table) => sum + table.logicalBytes, 0),
      activeMembers: row.members,
      stagingBytes:
        Math.max(requiredCheckpointBoundBytes, row.checkpoint_bytes ?? 0) +
        (row.pinned_bytes ?? 0) -
        (row.consumed_bytes ?? 0),
      requiredCheckpointBoundBytes,
      lastSnapshotBytes: row.last_snapshot_bytes ?? 0,
      checkpointReservationConsumedBytes: row.consumed_bytes ?? 0,
      checkpointBytes: row.checkpoint_bytes ?? 0,
      publishedPinnedBytes: row.pinned_bytes ?? 0,
      liveSourceReads: row.relay,
      sourcePayloadBytes: row.source_bytes,
      ...usage,
    };
  });
  const readHubInventoryTx = Effect.fn("MemoryStore.readHubInventoryTx")(function* (
    space: M.MemorySpaceId,
  ) {
    yield* Transaction;
    const now = yield* Clock.currentTimeMillis;
    const inventory = yield* stored(
      "hub-reserved-reclaimable",
      sql<{
        forget_bytes: number;
        forget_receipts: number;
        forget_keys: number;
        terminal_work_rows: number;
        terminal_work_bytes: number;
        source_bytes: number;
        snapshot_bytes: number;
        tail_rows: number;
        tail_bytes: number;
        history_bytes: number;
        expired_relays: number;
        expired_handles: number;
        admin_rows: number;
      }>`SELECT
      (SELECT count(*) FROM memory_outbox WHERE kind='admin') AS admin_rows,
      (SELECT count(*) FROM memory_hub_source_reads WHERE space=${space} AND state!='expired' AND deadline<=${now}) AS expired_relays,
      (SELECT count(*) FROM memory_hub_retention r,json_each(r.handles_json) h WHERE r.space=${space} AND json_extract(h.value,'$.expiresAt')<=${now}) AS expired_handles,
      (SELECT coalesce(sum(max(0,reserve_bytes-${M.MEMORY_IDENTITY_CORE_MAX_BYTES})),0) FROM memory_identity_ledger i WHERE i.space=${space} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)) AS forget_bytes,
      (SELECT count(*) FROM memory_identity_ledger i WHERE i.space=${space} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)) AS forget_receipts,
      (SELECT coalesce(sum(reserve_keys),0) FROM memory_identity_ledger i WHERE i.space=${space} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)) AS forget_keys,
      (SELECT count(*) FROM memory_outbox o WHERE o.space=${space} AND kind IN ('sync','resolve','revert_intent','rebuild') AND status IN ('completed','failed','cancelled') AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.operation_id=json_extract(o.metadata_json,'$.operationId'))) AS terminal_work_rows,
      (SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))+coalesce(length(CAST(ticket_json AS BLOB)),0)+coalesce(length(CAST(frozen_claim_json AS BLOB)),0)),0) FROM memory_outbox o WHERE o.space=${space} AND kind IN ('sync','resolve','revert_intent','rebuild') AND status IN ('completed','failed','cancelled') AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.operation_id=json_extract(o.metadata_json,'$.operationId'))) AS terminal_work_bytes,

      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p JOIN memory_hub_source_reads r ON r.space=p.space AND r.payload_ref=p.payload_ref WHERE r.space=${space} AND r.deadline<=${now}) AS source_bytes,
      (SELECT coalesce(sum(length(CAST(b.metadata_json AS BLOB))),0) FROM memory_inbox_pending b WHERE b.space=${space} AND b.reason='hub_snapshot' AND b.checkpoint_id!=coalesce((SELECT 'hub:'||checkpoint_id FROM memory_hub_retention WHERE space=${space}),'') AND NOT EXISTS(SELECT 1 FROM memory_hub_retention r,json_each(r.handles_json) h WHERE r.space=b.space AND 'hub:'||json_extract(h.value,'$.checkpointId')=b.checkpoint_id AND json_extract(h.value,'$.expiresAt')>${now})) AS snapshot_bytes,
      (SELECT count(*) FROM memory_hub_operations o JOIN memory_hub_retention r ON r.space=o.space WHERE o.space=${space} AND o.hub_sequence<=r.retention_floor AND o.committed_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=o.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=o.operation_id) AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=o.space AND json_extract(w.metadata_json,'$.operationId')=o.operation_id AND w.status IN ('pending','running','retry'))) AS tail_rows,
      (SELECT coalesce(sum(length(CAST(o.entry_json AS BLOB))),0) FROM memory_hub_operations o JOIN memory_hub_retention r ON r.space=o.space WHERE o.space=${space} AND o.hub_sequence<=r.retention_floor AND o.committed_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=o.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=o.operation_id) AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=o.space AND json_extract(w.metadata_json,'$.operationId')=o.operation_id AND w.status IN ('pending','running','retry'))) AS tail_bytes,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p JOIN memory_revisions v ON v.space=p.space AND v.payload_ref=p.payload_ref JOIN memory_compact_receipts c ON c.space=v.space AND c.operation_id=v.operation_id JOIN memory_hub_retention r ON r.space=v.space WHERE p.space=${space} AND p.purge_eligible_after<=${now} AND c.hub_sequence<=r.retention_floor
        AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=v.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=v.operation_id)
        AND NOT EXISTS(SELECT 1 FROM memory_items i,json_each(i.heads_json) h WHERE i.space=v.space AND h.value=v.revision_id)
        AND NOT EXISTS(SELECT 1 FROM memory_conflicts f,json_each(f.heads_json) h WHERE f.space=v.space AND f.status!='resolved' AND h.value=v.revision_id)
        AND NOT EXISTS(SELECT 1 FROM memory_resolutions x,json_each(x.input_revision_ids_json) h WHERE x.space=v.space AND x.revert_deadline>${now} AND h.value=v.revision_id)
        AND NOT EXISTS(SELECT 1 FROM memory_revert_intents x WHERE x.space=v.space AND (x.restored_revision_id=v.revision_id OR x.payload_ref=v.payload_ref))
        AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=v.space AND w.status IN ('pending','running','retry') AND (w.payload_ref=v.payload_ref OR instr(w.metadata_json,v.revision_id)>0 OR instr(coalesce(w.ticket_json,''),v.revision_id)>0 OR instr(coalesce(w.frozen_claim_json,''),v.revision_id)>0))
        AND NOT EXISTS(SELECT 1 FROM memory_inbox_pending b WHERE b.space=v.space AND (b.payload_ref=v.payload_ref OR b.reason='hub_snapshot' AND EXISTS(SELECT 1 FROM json_each(b.metadata_json,'$.revisions') j WHERE json_extract(j.value,'$.revision.revisionId')=v.revision_id AND json_type(j.value,'$.payload')!='null') AND (b.checkpoint_id='hub:'||r.checkpoint_id OR EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE 'hub:'||json_extract(h.value,'$.checkpointId')=b.checkpoint_id AND json_extract(h.value,'$.expiresAt')>${now}))))) AS history_bytes`,
    );
    const inventoryRow = inventory[0]!;
    const adminRows = yield* stored(
      "hub-admin-reclaimable",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE kind='admin' AND status='completed' AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND json_extract(admin_json,'$.stage')='acknowledged'`,
    );
    let adminBytes = 0;
    for (const row of adminRows) {
      const originalBytes = new TextEncoder().encode(row.admin_json).length;
      const guardBytes = new TextEncoder().encode(
        yield* adminReplayJson(yield* adminCodec.decode(row.admin_json, strict)),
      ).length;
      adminBytes += Math.max(0, originalBytes - guardBytes);
    }
    const details = yield* stored(
      "hub-reclaimable-details",
      sql<{ report_bytes: number; event_bytes: number; judgment_bytes: number }>`SELECT
      (SELECT coalesce(sum(${sql.unsafe(reportMetadataBytes("x."))}),0) FROM memory_report_outbox x WHERE space=${space} AND state='delivered' AND delivered_at<=${now - M.MEMORY_REPORT_DETAIL_RETENTION_MS} AND EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=x.space AND g.key_kind='report_delivered' AND g.key=x.report_id)) AS report_bytes,
      (SELECT coalesce(sum(length(CAST(e.metadata_json AS BLOB))+length(CAST(e.receipt_json AS BLOB))),0) FROM memory_events e JOIN memory_compact_receipts c ON c.space=e.memory_space_id AND c.operation_id=e.operation_id JOIN memory_hub_retention r ON r.space=c.space WHERE e.memory_space_id=${space} AND c.hub_sequence<=r.retention_floor AND e.created_at<=${now - M.MEMORY_LOG_RETENTION_MS}
        AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=c.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=e.operation_id)
        AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=c.space AND json_extract(w.metadata_json,'$.operationId')=e.operation_id AND w.status IN ('pending','running','retry'))
        AND NOT EXISTS(SELECT 1 FROM memory_inbox_pending b WHERE b.space=c.space AND b.operation_id=e.operation_id)) AS event_bytes,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_resolutions x JOIN memory_payloads p ON p.space=x.space AND p.payload_ref=x.judgment_payload_ref JOIN memory_compact_receipts c ON c.space=x.space AND json_extract(c.compact_json,'$.operationKind')='resolve' AND json_extract(c.compact_json,'$.resolutionId')=x.resolution_id AND json_extract(c.compact_json,'$.revisionId')=x.result_revision_id AND json_extract(c.compact_json,'$.receipt.memoryId')=x.memory_id AND json_extract(c.receipt_json,'$.outcome')='accepted' LEFT JOIN memory_revisions v ON v.space=x.space AND v.revision_id=x.result_revision_id JOIN memory_hub_retention r ON r.space=x.space WHERE x.space=${space} AND x.revert_deadline<=${now} AND c.hub_sequence<=r.retention_floor
        AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=c.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=c.operation_id)
        AND NOT EXISTS(SELECT 1 FROM memory_revert_intents i WHERE i.space=x.space AND i.resolution_id=x.resolution_id)
        AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=x.space AND w.status IN ('pending','running','retry') AND (w.payload_ref=x.judgment_payload_ref OR w.payload_ref=v.payload_ref OR instr(w.metadata_json,x.resolution_id)>0 OR instr(w.metadata_json,x.result_revision_id)>0 OR instr(coalesce(w.ticket_json,''),x.resolution_id)>0 OR instr(coalesce(w.ticket_json,''),x.result_revision_id)>0 OR instr(coalesce(w.frozen_claim_json,''),x.resolution_id)>0 OR instr(coalesce(w.frozen_claim_json,''),x.result_revision_id)>0))
        AND NOT EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.resolutions') j WHERE b.space=x.space AND b.reason='hub_snapshot' AND json_extract(j.value,'$.resolution.resolutionId')=x.resolution_id AND (b.checkpoint_id='hub:'||r.checkpoint_id OR EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE 'hub:'||json_extract(h.value,'$.checkpointId')=b.checkpoint_id AND json_extract(h.value,'$.expiresAt')>${now})))) AS judgment_bytes`,
    );

    return {
      reserved: {
        checkpoint_staging: (yield* readHubUsageTx(space)).requiredCheckpointBoundBytes,
        permanent_metadata:
          inventoryRow.forget_bytes +
          inventoryRow.forget_receipts * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
        receipts: inventoryRow.forget_receipts + inventoryRow.admin_rows,
        import_source_items: inventoryRow.forget_keys + inventoryRow.admin_rows,
      },
      reclaimable: {
        checkpoint_staging: inventoryRow.snapshot_bytes,
        relay_hub: inventoryRow.expired_relays,
        checkpoint_handles: inventoryRow.expired_handles,
        log_tail_rows: inventoryRow.tail_rows,
        log_tail_bytes: inventoryRow.tail_bytes + details[0]!.event_bytes,
        history: inventoryRow.history_bytes + details[0]!.judgment_bytes,
        permanent_metadata: adminBytes + details[0]!.report_bytes,
        work_items: inventoryRow.terminal_work_rows,
        work_bytes: inventoryRow.terminal_work_bytes + adminBytes + inventoryRow.source_bytes,
      },
    };
  });
  // Handles are counted from the bounded retention record, never by a physical page scan.
  const usageForHub = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "hub-handles",
      sql<{
        count: number;
      }>`SELECT coalesce(json_array_length(handles_json),0) AS count FROM memory_hub_retention WHERE space=${space}`,
    );
    const reports = yield* stored(
      "hub-report-counters",
      sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('report_all_rows','report_all_bytes','report_items','report_bytes')`,
    );
    const counters = new Map(reports.map((r) => [r.dimension, r.value]));
    return {
      liveHandles: rows[0]?.count ?? 0,
      reportItems: counters.get("report_items") ?? 0,
      reportBytes: counters.get("report_bytes") ?? 0,
      reportRows: counters.get("report_all_rows") ?? 0,
      reportMetadataBytes: counters.get("report_all_bytes") ?? 0,
    };
  });
  const reserveHubCheckpointTx: MemoryStoreShape["reserveHubCheckpointTx"] = Effect.fn(
    "MemoryStore.reserveHubCheckpointTx",
  )(function* (input) {
    yield* Transaction;
    yield* stored(
      "hub-reserve-init",
      sql`INSERT INTO memory_hub_retention(space) VALUES (${input.memorySpaceId}) ON CONFLICT(space) DO NOTHING`,
    );
    const rows = yield* stored(
      "hub-reserve",
      sql`UPDATE memory_hub_retention SET checkpoint_bytes=checkpoint_bytes+${input.checkpointDeltaBytes},published_pinned_bytes=published_pinned_bytes+${input.publishedPinnedDeltaBytes} WHERE space=${input.memorySpaceId}
      AND checkpoint_bytes+${input.checkpointDeltaBytes}>=0 AND published_pinned_bytes+${input.publishedPinnedDeltaBytes}>=0
      RETURNING space`,
    );
    if (!rows.length)
      return yield* new MemoryCapacityError({
        dimension: "checkpoint_staging",
        limit: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
      });
    return yield* readHubUsageTx(input.memorySpaceId);
  });
  return {
    readHubUsageTx,
    readHubInventoryTx,
    reserveHubCheckpointTx,
  };
};

export type HubUsage = ReturnType<typeof makeHubUsage>;
