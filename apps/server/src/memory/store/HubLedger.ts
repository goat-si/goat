import {
  checkpointKeys,
  emptyCheckpointInventory,
  selectCheckpointMemory,
} from "../MemoryCheckpointInventory.ts";
import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { HubMembership } from "./HubMembership.ts";
import type { HubSnapshotReads } from "./HubSnapshotReads.ts";
import type { HubUsage } from "./HubUsage.ts";
import type { ImportLineage } from "./ImportLineage.ts";
import type { Reports } from "./Reports.ts";
import {
  boundaryCodec,
  checkpointCodec,
  codec,
  compactCodec,
  handleCodec,
  hubEntryCodec,
  snapshotId,
  stored,
  stringArrayCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  CheckpointTokenGuardSchema,
  MemoryCapacityError,
  MemoryStorageError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { HubCheckpointHandle } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const emptyCompaction: M.MemoryCompactionStatus = {
  lastRunAtUtc: null,
  removedRows: 0,
  reclaimedLogicalBytes: 0,
  reclaimableLogicalBytes: 0,
  blockedReasons: [],
};
const compactionCodec = codec(M.MemoryCompactionStatus);
const cursorFor = (id: string, ordinal: number) => hashText(`${id}:${ordinal}`);

export const makeHubLedger = (
  kernel: Pick<StoreKernel, "sql">,
  hubSnapshotReads: Pick<HubSnapshotReads, "handlesFor" | "snapshotBytes" | "snapshotPages">,
  importLineage: Pick<ImportLineage, "requireImportLineageCompleteTx" | "retireImportBatchesTx">,
  reports: Pick<Reports, "purgeDeliveredReportDetailsTx">,
  hubMembership: Pick<HubMembership, "authorizeSource">,
  hubUsage: Pick<HubUsage, "readHubUsageTx" | "reserveHubCheckpointTx">,
) => {
  const { sql } = kernel;
  const { handlesFor, snapshotBytes, snapshotPages } = hubSnapshotReads;
  const { requireImportLineageCompleteTx, retireImportBatchesTx } = importLineage;
  const { purgeDeliveredReportDetailsTx } = reports;
  const { authorizeSource } = hubMembership;
  const { readHubUsageTx, reserveHubCheckpointTx } = hubUsage;
  const readHubReceiptTx: MemoryStoreShape["readHubReceiptTx"] = Effect.fn(
    "MemoryStore.readHubReceiptTx",
  )(function* (space, operationId) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-receipt",
      sql<{
        entry_json: string;
        committed_at: number;
      }>`SELECT entry_json,committed_at FROM memory_hub_operations WHERE space=${space} AND operation_id=${operationId}`,
    );
    if (rows[0])
      return {
        entry: yield* stored("hub-entry", hubEntryCodec.decode(rows[0].entry_json, strict)),
        committedAt: rows[0].committed_at,
      };
    const compact = yield* stored(
      "hub-compact-receipt",
      sql<{
        compact_json: string;
      }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${operationId}`,
    );
    if (!compact[0]) return undefined;
    const record = yield* stored(
      "hub-compact",
      compactCodec.decode(compact[0].compact_json, strict),
    );
    const entry: M.MemoryHubEntry = {
      kind: "metadata",
      operationKind: record.operationKind,
      hubSequence: record.receipt.hubSequence!,
      memoryId: record.receipt.memoryId,
      receipt: record.receipt,
      compactReceipt: record,
      ...(record.operationKind === "resolve" && record.resolutionId
        ? { resolutionId: record.resolutionId }
        : {}),
    };
    return {
      entry,
      committedAt: record.receipt.resolutionApproval
        ? Date.parse(record.receipt.resolutionApproval.appliedAtUtc)
        : 0,
    };
  });
  const readHubRetentionTx: MemoryStoreShape["readHubRetentionTx"] = Effect.fn(
    "MemoryStore.readHubRetentionTx",
  )(function* (space) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-retention",
      sql<{
        checkpoint_id: string | null;
        checkpoint_sequence: number;
        retention_floor: number;
        boundary_json: string | null;
        compaction_json: string | null;
      }>`SELECT * FROM memory_hub_retention WHERE space=${space}`,
    );
    const row = rows[0];
    return {
      memorySpaceId: space,
      checkpointId: row?.checkpoint_id ?? null,
      checkpointSequence: row?.checkpoint_sequence ?? 0,
      retentionFloor: row?.retention_floor ?? 0,
      causalBoundary: row?.boundary_json
        ? yield* boundaryCodec.decode(row.boundary_json, strict)
        : null,
      compaction: row?.compaction_json
        ? yield* compactionCodec.decode(row.compaction_json, strict)
        : emptyCompaction,
    };
  });
  const buildHubSnapshot = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    sequence: number,
    floor: number,
    id: string,
    now: number,
  ) {
    yield* requireImportLineageCompleteTx(space);
    const blank = (ordinal: number): M.MemoryHubCheckpointPage => ({
      memorySpaceId: space,
      checkpointSequence: sequence,
      retentionFloor: floor,
      causalBoundary: {
        checkpointSequence: sequence,
        boundaryId: hashText(`${space}:${id}:${sequence}`),
      },
      pageOrdinal: ordinal,
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
      nextCursor: cursorFor(id, ordinal + 1),
      bootstrapComplete: false,
    });
    const all = emptyCheckpointInventory();
    const ledger = yield* stored(
      "hub-snapshot-ledger",
      sql<{
        compact_json: string;
      }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND hub_sequence<=${sequence} ORDER BY operation_id`,
    );
    const receipts = yield* Effect.forEach(ledger, (row) =>
      compactCodec.decode(row.compact_json, strict),
    );
    const approved = new Set(
      receipts.filter((r) => r.receipt.outcome !== "rejected").map((r) => r.receipt.operationId),
    );
    // A joining member also needs body-free revision identity for the reverse
    // forget closure, even after the dependency is no longer a head.
    const lineageRows = yield* stored(
      "hub-snapshot-lineage",
      sql<{
        revision_id: string;
      }>`SELECT DISTINCT r.revision_id FROM memory_payloads p, json_each(p.dependencies_json) d JOIN memory_revisions r ON r.space=p.space AND r.revision_id=d.value WHERE p.space=${space}`,
    );
    const lineage = new Set(lineageRows.map((row) => M.MemoryRevisionId.make(row.revision_id)));
    const identities = yield* stored(
      "hub-snapshot-identities",
      sql<{
        memory_id: string;
      }>`SELECT memory_id FROM memory_identity_ledger WHERE space=${space} ORDER BY memory_id`,
    );
    for (const row of identities) {
      const current = yield* stored(
        "hub-snapshot-inventory",
        selectCheckpointMemory(space, M.MemoryId.make(row.memory_id), now, true, lineage).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
      const identity = current.identities[0];
      if (
        !identity ||
        !current.fences[0] ||
        !receipts.some(
          (r) =>
            r.receipt.operationId === identity.createOperationId &&
            r.receipt.memoryId === identity.memoryId &&
            (r.receipt.outcome === "accepted" ||
              r.receipt.outcome === "conflicted" ||
              (r.operationKind === "forget" &&
                r.receipt.outcome === "deleted" &&
                current.tombstones[0]?.deleteOperationId === r.receipt.operationId)),
        )
      )
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
      if (
        current.tombstones.some((t) => !approved.has(t.deleteOperationId)) ||
        current.revisions.some((p) => !approved.has(p.revision.operationId))
      )
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
      if (
        current.resolutions.some(
          ({ resolution }) =>
            !receipts.some(
              (r) =>
                r.operationKind === "resolve" &&
                r.resolutionId === resolution.resolutionId &&
                r.receipt.resolutionApproval,
            ),
        )
      )
        return yield* new MemoryStoreConflict({ code: "unsupported_protocol" });
      // Arrays share the selector and literal-record encoder with admission accounting.
      all.items.push(...current.items);
      all.revisions.push(...current.revisions);
      all.tombstones.push(...current.tombstones);
      all.conflicts.push(...current.conflicts);
      all.resolutions.push(...current.resolutions);
      all.identities.push(...current.identities);
      all.fences.push(...current.fences);
      all.suppressions.push(...current.suppressions);
      all.importLineage.push(...current.importLineage);
    }
    const lineageCount = yield* stored(
      "hub-snapshot-lineage-complete",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_import_lineage WHERE space=${space}`,
    );
    if (all.importLineage.length !== lineageCount[0]!.count)
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    all.compactReceipts = receipts;
    const keys = checkpointKeys;
    const pages: M.MemoryHubCheckpointPage[] = [];
    let page = blank(0);
    let count = 0;
    // Measure the complete pull envelope with the longest continuation before accepting a record.
    const pageSize = (value: M.MemoryHubCheckpointPage) =>
      codec(M.MemoryHubPullResult)
        .encode({
          highWatermark: sequence,
          throughSequence: sequence,
          hasMore: true,
          entries: [],
          checkpoint: value,
        })
        .pipe(Effect.map((json) => new TextEncoder().encode(json).length));
    for (const key of keys)
      for (const record of all[key]) {
        const next = { ...page, [key]: [...page[key], record] };
        const size = yield* pageSize(next).pipe(Effect.option);
        if (count === 100 || Option.isNone(size)) {
          if (count === 0) return yield* new MemoryStoreConflict({ code: "payload_too_large" });
          pages.push(page);
          page = blank(pages.length);
          count = 0;
        }
        page = { ...page, [key]: [...page[key], record] };
        yield* pageSize(page);
        count++;
      }
    page = { ...page, bootstrapComplete: true, nextCursor: null };
    pages.push(page);
    if (!M.validateMemoryCheckpointRecords(pages))
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    return pages;
  });
  // Both producers and member joins stage the same complete immutable snapshot. Only joins issue handles.
  const stageHubSnapshotTx = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    checkpointId: string,
    now: number,
  ) {
    yield* Transaction;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(checkpointId))
      return yield* new M.MemoryHubError({ code: "invalid_cursor" });
    const retention = yield* readHubRetentionTx(space);
    const rows = yield* stored(
      "hub-snapshot-sequence",
      sql<{
        sequence: number;
      }>`SELECT coalesce(max(hub_sequence),0) AS sequence FROM memory_hub_operations WHERE space=${space}`,
    );
    const sequence = Math.max(rows[0]!.sequence, retention.checkpointSequence);
    let pages = yield* snapshotPages(space, checkpointId);
    const builtNewSnapshot = pages.length === 0;
    if (builtNewSnapshot) {
      pages = yield* buildHubSnapshot(space, sequence, retention.retentionFloor, checkpointId, now);
      const encoded = yield* Effect.forEach(pages, (page) => checkpointCodec.encode(page));
      const bytes = encoded.reduce((sum, json) => sum + new TextEncoder().encode(json).length, 0);
      const usage = yield* readHubUsageTx(space);
      if (bytes > usage.requiredCheckpointBoundBytes)
        return yield* new MemoryStorageError({
          stage: "checkpoint-bound-underflow",
          cause: undefined,
        });
      yield* reserveHubCheckpointTx({
        memorySpaceId: space,
        checkpointDeltaBytes: bytes - usage.checkpointBytes,
        publishedPinnedDeltaBytes: bytes,
      });
      yield* stored(
        "hub-snapshot-size",
        sql`UPDATE memory_hub_retention SET last_snapshot_bytes=${bytes} WHERE space=${space}`,
      );
      for (let ordinal = 0; ordinal < pages.length; ordinal++)
        yield* stored(
          "hub-snapshot-stage",
          sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,missing_parents_json,reason,hub_sequence,checkpoint_id,page_ordinal,metadata_json) VALUES (${space},${`${snapshotId(checkpointId)}:${ordinal}`},'checkpoint','[]','hub_snapshot',${sequence},${snapshotId(checkpointId)},${ordinal},${encoded[ordinal]!})`,
        );
    }
    const first = pages[0]!;
    // Unpublished, unpinned producer staging can consume the reserved slot: input writers reclaim it atomically.
    // Publishing or issuing a handle makes the pages retained bytes and requires admission for the lost credit.
    if (builtNewSnapshot)
      yield* stored(
        "hub-snapshot-reservation-consumed",
        sql`UPDATE memory_hub_retention SET reserved_snapshot_id=${checkpointId},last_snapshot_bytes=(SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))),0) FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' AND checkpoint_id=${snapshotId(checkpointId)}),snapshot_generation=coalesce((SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation' AND scope_key=''),0) WHERE space=${space}`,
      );
    return { pages, first };
  });
  const prepareHubProducerCheckpointTx: MemoryStoreShape["prepareHubProducerCheckpointTx"] =
    Effect.fn("MemoryStore.prepareHubProducerCheckpointTx")(function* (input) {
      const space = input.authority.principal.memorySpaceId;
      const { member, now } = yield* authorizeSource(input.authority, space);
      if (member.environmentId !== input.hubEnvironmentId)
        return yield* new M.MemoryHubForbiddenError({});
      const { first } = yield* stageHubSnapshotTx(space, input.checkpointId, now);
      return { checkpointId: input.checkpointId, checkpointSequence: first.checkpointSequence };
    });
  const prepareHubCheckpointTx: MemoryStoreShape["prepareHubCheckpointTx"] = Effect.fn(
    "MemoryStore.prepareHubCheckpointTx",
  )(function* (input) {
    const space = input.authority.principal.memorySpaceId;
    const { member, now } = yield* authorizeSource(input.authority, space);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.checkpointId) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(input.snapshotToken)
    )
      return yield* new M.MemoryHubError({ code: "invalid_cursor" });
    const handles = yield* handlesFor(space);
    const replay = handles.find((h) => h.snapshotToken === input.snapshotToken);
    if (replay) {
      if (
        replay.memberEnvironmentId !== member.environmentId ||
        replay.credentialVersion !== member.credentialVersion ||
        replay.checkpointId !== input.checkpointId ||
        replay.hubEnvironmentId !== input.hubEnvironmentId
      )
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      if (replay.expiresAt <= now) return yield* new M.MemoryHubError({ code: "cursor_expired" });
      return replay;
    }
    const tokenKey = hashText(input.snapshotToken);
    const prior = yield* stored(
      "hub-token-guard",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' AND key=${tokenKey}`,
    );
    if (prior.length) return yield* new M.MemoryHubError({ code: "cursor_expired" });
    const guards = yield* stored(
      "hub-token-budget",
      sql<{
        rows: number;
        bytes: number;
      }>`SELECT count(*) AS rows,coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM memory_import_keys WHERE space=${space}`,
    );
    if (guards[0]!.rows >= M.MEMORY_DEDUP_MAX_RECEIPTS)
      return yield* new MemoryCapacityError({
        dimension: "dedup_receipts",
        limit: M.MEMORY_DEDUP_MAX_RECEIPTS,
      });
    const active = handles.filter(
      (h) => h.expiresAt > now && h.memberEnvironmentId !== member.environmentId,
    );
    if (active.length >= M.MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB)
      return yield* new MemoryCapacityError({
        dimension: "checkpoint_handles",
        limit: M.MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB,
      });
    const { pages, first } = yield* stageHubSnapshotTx(space, input.checkpointId, now);
    const handle: HubCheckpointHandle = {
      checkpointId: input.checkpointId,
      snapshotToken: input.snapshotToken,
      memorySpaceId: space,
      hubEnvironmentId: input.hubEnvironmentId,
      memberEnvironmentId: member.environmentId,
      credentialVersion: member.credentialVersion,
      checkpointSequence: first.checkpointSequence,
      retentionFloor: first.retentionFloor,
      firstIssuedAt: now,
      expiresAt: now + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
      pageCount: pages.length,
    };
    const guardJson = yield* codec(CheckpointTokenGuardSchema).encode({ handle, retired: false });
    if (
      guards[0]!.bytes + new TextEncoder().encode(guardJson).length >
      M.MEMORY_PERMANENT_METADATA_MAX_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "permanent_metadata",
        limit: M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
      });
    for (const previous of handles.filter((h) => h.memberEnvironmentId === member.environmentId))
      yield* stored(
        "hub-token-retire",
        sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true')) WHERE space=${space} AND key_kind='hub_checkpoint_token' AND key=${hashText(previous.snapshotToken)}`,
      );
    yield* stored(
      "hub-token-first-issue",
      sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hub_checkpoint_token',${tokenKey},${space},${guardJson})`,
    );
    yield* stored(
      "hub-snapshot-pin",
      sql`UPDATE memory_hub_retention SET handles_json=${yield* handleCodec.encode([...active, handle])} WHERE space=${space}`,
    );
    return handle;
  });
  const readHubCheckpointPageTx: MemoryStoreShape["readHubCheckpointPageTx"] = Effect.fn(
    "MemoryStore.readHubCheckpointPageTx",
  )(function* (input) {
    const space = input.authority.principal.memorySpaceId;
    const { member, now } = yield* authorizeSource(input.authority, space);
    const handle = (yield* handlesFor(space)).find((h) => h.snapshotToken === input.snapshotToken);
    if (!handle || handle.expiresAt <= now)
      return yield* new M.MemoryHubError({ code: "cursor_expired" });
    if (
      handle.memberEnvironmentId !== member.environmentId ||
      handle.credentialVersion !== member.credentialVersion
    )
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    const pages = yield* snapshotPages(space, handle.checkpointId);
    const ordinal =
      input.cursor === null
        ? 0
        : pages.findIndex((_, i) => cursorFor(handle.checkpointId, i) === input.cursor);
    if (ordinal < 0 || !pages[ordinal] || pages.length !== handle.pageCount)
      return yield* new M.MemoryHubError({ code: "invalid_cursor" });
    return pages[ordinal]!;
  });
  const publishCheckpointAndFloorTx: MemoryStoreShape["publishCheckpointAndFloorTx"] = Effect.fn(
    "MemoryStore.publishCheckpointAndFloorTx",
  )(function* (input) {
    yield* Transaction;
    yield* requireImportLineageCompleteTx(input.memorySpaceId);
    const old = yield* readHubRetentionTx(input.memorySpaceId);
    if (old.checkpointId === input.checkpointId && old.retentionFloor === input.nextFloor)
      return old;
    if (old.retentionFloor !== input.expectedFloor)
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const pages = yield* snapshotPages(input.memorySpaceId, input.checkpointId);
    if (!M.validateMemoryCheckpointRecords(pages))
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    const first = pages[0]!;
    const handles = (yield* handlesFor(input.memorySpaceId)).filter((h) => h.expiresAt > input.now);
    if (
      input.nextFloor < old.retentionFloor ||
      input.nextFloor > first.checkpointSequence ||
      first.checkpointSequence < old.checkpointSequence ||
      handles.some((h) => h.checkpointSequence < input.nextFloor)
    )
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    // Pages are complete and durable before either recovery state or its operational floor moves.
    yield* stored(
      "hub-snapshot-publish",
      sql`UPDATE memory_hub_retention SET checkpoint_id=${input.checkpointId},checkpoint_sequence=${first.checkpointSequence},retention_floor=${input.nextFloor},boundary_json=${yield* boundaryCodec.encode(first.causalBoundary)},handles_json=${yield* handleCodec.encode(handles)} WHERE space=${input.memorySpaceId}`,
    );
    yield* stored(
      "hub-snapshot-bootstrap",
      sql`INSERT INTO memory_compaction_state(space,checkpoint_id,boundary_json,retained_revision_boundary,published) VALUES (${input.memorySpaceId},${input.checkpointId},${yield* boundaryCodec.encode(first.causalBoundary)},${input.nextFloor},1) ON CONFLICT(space) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,boundary_json=excluded.boundary_json,retained_revision_boundary=excluded.retained_revision_boundary,published=1`,
    );
    const keep = new Set([input.checkpointId, ...handles.map((h) => h.checkpointId)]);
    const retired = yield* stored(
      "hub-snapshot-retired",
      sql<{
        checkpoint_id: string;
      }>`SELECT DISTINCT checkpoint_id FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND reason='hub_snapshot'`,
    );
    const before = yield* snapshotBytes(input.memorySpaceId);
    for (const row of retired)
      if (!keep.has(row.checkpoint_id.slice(4)))
        yield* stored(
          "hub-snapshot-retire",
          sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${row.checkpoint_id} AND reason='hub_snapshot'`,
        );
    yield* reserveHubCheckpointTx({
      memorySpaceId: input.memorySpaceId,
      checkpointDeltaBytes: 0,
      publishedPinnedDeltaBytes: (yield* snapshotBytes(input.memorySpaceId)) - before,
    });
    return yield* readHubRetentionTx(input.memorySpaceId);
  });
  const compactEligibleHistoryTx: MemoryStoreShape["compactEligibleHistoryTx"] = Effect.fn(
    "MemoryStore.compactEligibleHistoryTx",
  )(function* (input) {
    yield* Transaction;
    yield* requireImportLineageCompleteTx(input.memorySpaceId);
    yield* retireImportBatchesTx(input.memorySpaceId, input.now, input.limit);
    const retention = yield* readHubRetentionTx(input.memorySpaceId);
    if (retention.retentionFloor !== input.expectedFloor || !retention.checkpointId)
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const pages = yield* snapshotPages(input.memorySpaceId, retention.checkpointId);
    if (!M.validateMemoryCheckpointRecords(pages))
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    const covered = new Set(
      pages.flatMap((p) => p.compactReceipts.map((r) => r.receipt.operationId)),
    );
    const rows = yield* stored(
      "hub-compact-tail",
      sql<{
        operation_id: string;
        bytes: number;
      }>`SELECT operation_id,length(CAST(entry_json AS BLOB)) AS bytes FROM memory_hub_operations WHERE space=${input.memorySpaceId} AND hub_sequence<=${input.expectedFloor} AND committed_at<=${input.now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=memory_hub_operations.space AND json_extract(o.metadata_json,'$.operationId')=memory_hub_operations.operation_id AND o.status IN ('pending','running','retry')) ORDER BY hub_sequence LIMIT ${Math.max(0, Math.min(input.limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
    );
    let removedRows = 0,
      reclaimedLogicalBytes = 0;
    for (const row of rows) {
      if (!covered.has(M.MemoryOperationId.make(row.operation_id))) continue;
      yield* stored(
        "hub-compact-delete",
        sql`DELETE FROM memory_hub_operations WHERE space=${input.memorySpaceId} AND operation_id=${row.operation_id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += row.bytes;
    }
    const limit = Math.max(0, Math.min(input.limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS));
    const events = yield* stored(
      "hub-compact-events",
      sql<{
        operation_id: string;
        bytes: number;
      }>`SELECT e.operation_id,length(CAST(e.metadata_json AS BLOB))+length(CAST(e.receipt_json AS BLOB)) AS bytes FROM memory_events e JOIN memory_compact_receipts c ON c.space=e.memory_space_id AND c.operation_id=e.operation_id WHERE e.memory_space_id=${input.memorySpaceId} AND c.hub_sequence<=${input.expectedFloor} AND e.created_at<=${input.now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=e.memory_space_id AND json_extract(o.metadata_json,'$.operationId')=e.operation_id AND o.status IN ('pending','running','retry')) AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending p WHERE p.space=e.memory_space_id AND p.operation_id=e.operation_id) ORDER BY e.sequence LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const event of events) {
      if (!covered.has(M.MemoryOperationId.make(event.operation_id))) continue;
      yield* stored(
        "hub-compact-event-delete",
        sql`DELETE FROM memory_events WHERE memory_space_id=${input.memorySpaceId} AND operation_id=${event.operation_id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += event.bytes;
    }
    // Snapshot bodies survive independently. Keep canonical references while the published or a live pinned page needs them.
    const liveHandles = (yield* handlesFor(input.memorySpaceId)).filter(
      (h) => h.expiresAt > input.now,
    );
    const keep = yield* stringArrayCodec.encode([
      snapshotId(retention.checkpointId),
      ...liveHandles.map((h) => snapshotId(h.checkpointId)),
    ]);
    const revisions = yield* stored(
      "hub-compact-revisions",
      sql<{
        revision_id: string;
        operation_id: string;
        payload_ref: string;
        payload_bytes: number;
        bytes: number;
      }>`SELECT r.revision_id,r.operation_id,r.payload_ref,coalesce(length(CAST(p.body_json AS BLOB)),0) AS payload_bytes,coalesce(length(CAST(p.body_json AS BLOB)),0)+length(CAST(r.parents_json AS BLOB))+length(CAST(r.provenance_json AS BLOB))+length(CAST(r.scope_json AS BLOB)) AS bytes FROM memory_revisions r JOIN memory_compact_receipts c ON c.space=r.space AND c.operation_id=r.operation_id LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${input.memorySpaceId} AND c.hub_sequence<=${input.expectedFloor} AND (p.purge_eligible_after<=${input.now} OR p.payload_ref IS NULL AND r.created_at<=${input.now - M.MEMORY_LOG_RETENTION_MS})
      AND NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=r.space AND h.value=r.revision_id)
      AND NOT EXISTS (SELECT 1 FROM memory_conflicts f JOIN json_each(f.heads_json) h WHERE f.space=r.space AND f.status!='resolved' AND h.value=r.revision_id)
      AND NOT EXISTS (SELECT 1 FROM memory_resolutions v JOIN json_each(v.input_revision_ids_json) h WHERE v.space=r.space AND v.revert_deadline>${input.now} AND h.value=r.revision_id)
      AND NOT EXISTS (SELECT 1 FROM memory_revert_intents v WHERE v.space=r.space AND (v.restored_revision_id=r.revision_id OR v.payload_ref=r.payload_ref))
      AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=r.space AND o.status IN ('pending','running','retry') AND (o.payload_ref=r.payload_ref OR instr(o.metadata_json,r.revision_id)>0 OR instr(coalesce(o.ticket_json,''),r.revision_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.revision_id)>0))
      AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending b WHERE b.space=r.space AND (b.payload_ref=r.payload_ref OR b.reason='hub_snapshot' AND b.checkpoint_id IN (SELECT value FROM json_each(${keep})) AND EXISTS (SELECT 1 FROM json_each(b.metadata_json,'$.revisions') j WHERE json_extract(j.value,'$.revision.revisionId')=r.revision_id AND json_type(j.value,'$.payload')!='null')))
      AND (p.payload_ref IS NOT NULL OR (NOT EXISTS (SELECT 1 FROM memory_payloads d, json_each(d.dependencies_json) dep WHERE d.space=r.space AND dep.value=r.revision_id)
        AND NOT EXISTS (SELECT 1 FROM memory_outbox o,json_each(o.metadata_json,'$.revisions') dep WHERE o.space='_worker' AND json_extract(o.metadata_json,'$.kind')='threadLineage' AND json_extract(o.metadata_json,'$.memorySpaceId')=r.space AND dep.value=r.revision_id)))
      ORDER BY coalesce(p.purge_eligible_after,r.created_at),r.revision_id LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const revision of revisions) {
      if (!covered.has(M.MemoryOperationId.make(revision.operation_id))) continue;
      const deleted = yield* stored(
        "hub-compact-payload-delete",
        sql<{
          bytes: number;
        }>`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${revision.payload_ref}
        AND NOT EXISTS (SELECT 1 FROM memory_revisions v WHERE v.space=${input.memorySpaceId} AND v.payload_ref=${revision.payload_ref} AND v.revision_id!=${revision.revision_id}) RETURNING length(CAST(body_json AS BLOB)) AS bytes`,
      );
      // Keep only canonical identity metadata while a live payload needs the
      // revision->memory edge for forget's reverse closure. Its body was deleted above.
      const retained = yield* stored(
        "hub-compact-lineage-reference",
        sql`SELECT 1 FROM memory_payloads p, json_each(p.dependencies_json) d WHERE p.space=${input.memorySpaceId} AND d.value=${revision.revision_id}
          UNION ALL SELECT 1 FROM memory_outbox o,json_each(o.metadata_json,'$.revisions') d WHERE o.space='_worker' AND json_extract(o.metadata_json,'$.kind')='threadLineage' AND json_extract(o.metadata_json,'$.memorySpaceId')=${input.memorySpaceId} AND d.value=${revision.revision_id} LIMIT 1`,
      );
      if (retained.length) {
        removedRows++;
        reclaimedLogicalBytes += revision.payload_bytes;
        continue;
      }
      yield* stored(
        "hub-compact-revision-delete",
        sql`DELETE FROM memory_revisions WHERE space=${input.memorySpaceId} AND revision_id=${revision.revision_id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += revision.bytes - revision.payload_bytes + (deleted[0]?.bytes ?? 0);
    }
    const judgments = yield* stored(
      "hub-compact-judgments",
      sql<{
        resolution_id: string;
        operation_id: string;
        judgment_payload_ref: string;
        bytes: number;
      }>`SELECT r.resolution_id,c.operation_id,r.judgment_payload_ref,length(CAST(p.body_json AS BLOB)) AS bytes FROM memory_resolutions r JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.judgment_payload_ref JOIN memory_compact_receipts c ON c.space=r.space AND json_extract(c.compact_json,'$.operationKind')='resolve' AND json_extract(c.compact_json,'$.resolutionId')=r.resolution_id AND json_extract(c.compact_json,'$.revisionId')=r.result_revision_id AND json_extract(c.compact_json,'$.receipt.memoryId')=r.memory_id AND json_extract(c.receipt_json,'$.outcome')='accepted' LEFT JOIN memory_revisions v ON v.space=r.space AND v.revision_id=r.result_revision_id WHERE r.space=${input.memorySpaceId} AND r.revert_deadline<=${input.now} AND c.hub_sequence<=${input.expectedFloor}
      AND NOT EXISTS (SELECT 1 FROM memory_revert_intents i WHERE i.space=r.space AND i.resolution_id=r.resolution_id)
      AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=r.space AND o.status IN ('pending','running','retry') AND (o.payload_ref=r.judgment_payload_ref OR o.payload_ref=v.payload_ref OR instr(o.metadata_json,r.resolution_id)>0 OR instr(o.metadata_json,r.result_revision_id)>0 OR instr(coalesce(o.ticket_json,''),r.resolution_id)>0 OR instr(coalesce(o.ticket_json,''),r.result_revision_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.resolution_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.result_revision_id)>0))
      AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending b JOIN json_each(b.metadata_json,'$.resolutions') j WHERE b.space=r.space AND b.reason='hub_snapshot' AND b.checkpoint_id IN (SELECT value FROM json_each(${keep})) AND json_extract(j.value,'$.resolution.resolutionId')=r.resolution_id)
      ORDER BY r.revert_deadline,r.resolution_id LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const judgment of judgments) {
      if (!covered.has(M.MemoryOperationId.make(judgment.operation_id))) continue;
      yield* stored(
        "hub-compact-judgment-delete",
        sql`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${judgment.judgment_payload_ref}`,
      );
      removedRows++;
      reclaimedLogicalBytes += judgment.bytes;
    }
    const terminalWork = yield* stored(
      "hub-compact-terminal-work",
      sql<{
        id: string;
        bytes: number;
      }>`SELECT id,length(CAST(metadata_json AS BLOB))+coalesce(length(CAST(ticket_json AS BLOB)),0)+coalesce(length(CAST(frozen_claim_json AS BLOB)),0) AS bytes FROM memory_outbox o WHERE space=${input.memorySpaceId} AND kind IN ('sync','resolve','revert_intent','rebuild') AND status IN ('completed','failed','cancelled') AND terminal_at<=${input.now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.operation_id=json_extract(o.metadata_json,'$.operationId')) ORDER BY terminal_at,id LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const work of terminalWork) {
      yield* stored(
        "hub-compact-terminal-work-delete",
        sql`DELETE FROM memory_outbox WHERE id=${work.id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += work.bytes;
    }
    const purgedReports = yield* purgeDeliveredReportDetailsTx({
      memorySpaceId: input.memorySpaceId,
      now: input.now,
      limit: Math.max(0, limit - removedRows),
    });
    removedRows += purgedReports.removedRows;
    reclaimedLogicalBytes += purgedReports.reclaimedLogicalBytes;
    const status: M.MemoryCompactionStatus = {
      lastRunAtUtc: M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(input.now))),
      removedRows,
      reclaimedLogicalBytes,
      reclaimableLogicalBytes: 0,
      blockedReasons: [],
    };
    yield* stored(
      "hub-compact-status",
      sql`UPDATE memory_hub_retention SET compaction_json=${yield* compactionCodec.encode(status)} WHERE space=${input.memorySpaceId}`,
    );
    return status;
  });
  return {
    readHubReceiptTx,
    readHubRetentionTx,
    prepareHubProducerCheckpointTx,
    prepareHubCheckpointTx,
    readHubCheckpointPageTx,
    publishCheckpointAndFloorTx,
    compactEligibleHistoryTx,
  };
};

export type HubLedger = ReturnType<typeof makeHubLedger>;
