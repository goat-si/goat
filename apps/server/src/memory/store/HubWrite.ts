import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Accounting } from "./Accounting.ts";
import type { CoreReads } from "./CoreReads.ts";
import type { HubLedger } from "./HubLedger.ts";
import type { HubMembership } from "./HubMembership.ts";
import type { HubUsage } from "./HubUsage.ts";
import type { ImportLineage } from "./ImportLineage.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import {
  claimCodec,
  codec,
  decodeOperation,
  fenceCodec,
  headsCodec,
  hubEntryCodec,
  lineageForRevision,
  provenanceCodec,
  receiptCodec,
  scopeCodec,
  selectionCodec,
  stored,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  HubAttemptReplay,
  MemoryCapacityError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  resolutionReportId,
  sameHeadSet,
  strict,
} from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const hubReceiptDecode = Schema.decodeUnknownEffect(M.MemoryHubReceipt);
const hubEntryDecode = Schema.decodeUnknownEffect(M.MemoryHubEntry);

export const makeHubWrite = (
  kernel: Pick<StoreKernel, "emit" | "nextWatermark" | "sql">,
  coreReads: Pick<CoreReads, "loadAggregate" | "receipt">,
  itemWrites: Pick<ItemWrites, "purge" | "putItem" | "writeSuppressions">,
  accounting: Pick<Accounting, "persistCompactReceipt">,
  importLineage: Pick<ImportLineage, "persistImportLineageTx" | "settleImportOperationTx">,
  hubMembership: Pick<HubMembership, "requireHubMemberTx">,
  hubUsage: Pick<HubUsage, "readHubUsageTx">,
  hubLedger: Pick<HubLedger, "readHubReceiptTx" | "readHubRetentionTx">,
) => {
  const { emit, nextWatermark, sql } = kernel;
  const { loadAggregate, receipt } = coreReads;
  const { purge, putItem, writeSuppressions } = itemWrites;
  const { persistCompactReceipt } = accounting;
  const { persistImportLineageTx, settleImportOperationTx } = importLineage;
  const { requireHubMemberTx } = hubMembership;
  const { readHubUsageTx } = hubUsage;
  const { readHubReceiptTx, readHubRetentionTx } = hubLedger;
  const appendHubEntryTx: MemoryStoreShape["appendHubEntryTx"] = Effect.fn(
    "MemoryStore.appendHubEntryTx",
  )(function* (input) {
    yield* Transaction;
    const op = yield* stored("hub-operation", decodeOperation(input.operation, strict));
    if (hashText(M.encodeMemoryOperation(op)) !== input.operationDigest)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const old = yield* readHubReceiptTx(op.memorySpaceId, op.operationId);
    if (old) {
      if (old.entry.receipt.operationDigest !== input.operationDigest)
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      return old;
    }
    const aggregate = yield* loadAggregate(op.memorySpaceId, op.memoryId, {}, {});
    const reservedDelete =
      op.kind === "forget" &&
      aggregate.identity !== undefined &&
      (!aggregate.tombstone || aggregate.tombstone.deleteOperationId === op.operationId);
    const counts = yield* readHubUsageTx(op.memorySpaceId);
    if (!reservedDelete && counts.tailRows >= M.MEMORY_LOG_MAX_TAIL_ROWS)
      return yield* new MemoryCapacityError({
        dimension: "log_tail_rows",
        limit: M.MEMORY_LOG_MAX_TAIL_ROWS,
      });
    const inserted = yield* stored(
      "hub-append",
      sql<{
        hub_sequence: number;
      }>`INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) VALUES (${op.memorySpaceId},${op.operationId},${op.memoryId},${op.originEnvironmentId},${input.operationDigest},'{}',${input.now}) RETURNING hub_sequence`,
    );
    const hubSequence = inserted[0]!.hub_sequence;
    const receipt = yield* stored(
      "hub-receipt-codec",
      hubReceiptDecode(
        {
          operationId: op.operationId,
          memoryId: op.memoryId,
          operationDigest: input.operationDigest,
          outcome: input.outcome,
          hubSequence,
          ...(input.failureCode ? { failureCode: input.failureCode } : {}),
          ...(input.capacity ? { capacity: input.capacity } : {}),
          ...(input.resolutionApproval ? { resolutionApproval: input.resolutionApproval } : {}),
        },
        strict,
      ),
    );
    const entry: M.MemoryHubEntry =
      input.outcome === "rejected"
        ? {
            kind: "metadata",
            operationKind: op.kind,
            hubSequence,
            receipt,
            memoryId: op.memoryId,
            ...(op.kind === "resolve" ? { resolutionId: op.resolution.resolutionId } : {}),
          }
        : { kind: "operation", hubSequence, receipt, operation: op };
    const json = yield* stored("hub-entry-codec", hubEntryCodec.encode(entry));
    if (
      !reservedDelete &&
      counts.tailBytes + new TextEncoder().encode(json).length > M.MEMORY_LOG_MAX_TAIL_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "log_tail_bytes",
        limit: M.MEMORY_LOG_MAX_TAIL_BYTES,
      });
    yield* stored(
      "hub-append-finalize",
      sql`UPDATE memory_hub_operations SET entry_json=${json},payload_ref=${op.kind === "forget" ? null : op.revision.payloadRef} WHERE hub_sequence=${hubSequence}`,
    );
    const record: M.MemoryCompactReceipt = {
      memorySpaceId: op.memorySpaceId,
      originEnvironmentId: op.originEnvironmentId,
      operationKind: op.kind,
      ...(op.kind === "upsert" && op.revision.provenance.upsertRequestDigest !== undefined
        ? { upsertRequestDigest: op.revision.provenance.upsertRequestDigest }
        : {}),
      receipt,
      revisionId:
        op.kind === "forget" || input.outcome === "rejected" ? null : op.revision.revisionId,
      resolutionId:
        op.kind === "resolve"
          ? op.resolution.resolutionId
          : op.kind === "revert"
            ? op.revertsResolutionId
            : null,
      revertsResolutionId: op.kind === "revert" ? op.revertsResolutionId : null,
      attemptId:
        op.kind === "resolve" ? (aggregate.fence?.activeLease?.attemptId ?? op.operationId) : null,
      fencingToken: op.kind === "resolve" ? op.fencingToken : null,
      reportGuard:
        (op.kind === "resolve" || op.kind === "revert") &&
        (input.outcome === "accepted" || input.outcome === "conflicted")
          ? {
              reportId: resolutionReportId(
                op.memorySpaceId,
                op.operationId,
                op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId,
              ),
              resolvingEnvironmentId: op.originEnvironmentId,
              resolutionId:
                op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId,
              outcome: op.kind === "resolve" ? "resolved" : "reverted",
            }
          : null,
    };
    yield* persistCompactReceipt(record);
    const finalEntry = entry.kind === "metadata" ? { ...entry, compactReceipt: record } : entry;
    const finalJson = yield* hubEntryCodec.encode(finalEntry);
    if (
      !reservedDelete &&
      counts.tailBytes + new TextEncoder().encode(finalJson).length > M.MEMORY_LOG_MAX_TAIL_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "log_tail_bytes",
        limit: M.MEMORY_LOG_MAX_TAIL_BYTES,
      });
    yield* stored(
      "hub-append-guard",
      sql`UPDATE memory_hub_operations SET entry_json=${finalJson} WHERE hub_sequence=${hubSequence}`,
    );
    return { entry: finalEntry, committedAt: input.now };
  });
  const readHubTailTx: MemoryStoreShape["readHubTailTx"] = Effect.fn("MemoryStore.readHubTailTx")(
    function* (input) {
      yield* Transaction;
      const retention = yield* readHubRetentionTx(input.memorySpaceId);
      if (input.afterSequence < retention.retentionFloor)
        return yield* new M.MemoryHubError({ code: "cursor_expired" });
      const max = yield* stored(
        "hub-watermark",
        sql<{
          sequence: number;
        }>`SELECT coalesce(max(hub_sequence),0) AS sequence FROM memory_hub_operations WHERE space=${input.memorySpaceId}`,
      );
      const highWatermark =
        input.highWatermark ?? Math.max(max[0]!.sequence, retention.checkpointSequence);
      if (input.afterSequence > highWatermark)
        return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
      const rows = yield* stored(
        "hub-tail",
        sql<{
          entry_json: string;
        }>`SELECT entry_json FROM memory_hub_operations WHERE space=${input.memorySpaceId} AND hub_sequence>${input.afterSequence} AND hub_sequence<=${highWatermark} ORDER BY hub_sequence LIMIT ${Math.max(1, Math.min(input.limit, M.MEMORY_PAGE_MAX_ITEMS)) + 1}`,
      );
      const entries: M.MemoryHubEntry[] = [];
      const maxBytes = Math.min(input.maxBytes, 262144);
      for (const row of rows.slice(
        0,
        Math.max(1, Math.min(input.limit, M.MEMORY_PAGE_MAX_ITEMS)),
      )) {
        const entry = yield* hubEntryCodec.decode(row.entry_json, strict);
        const next = [...entries, entry];
        const size = new TextEncoder().encode(
          yield* codec(M.MemoryHubPullResult).encode({
            entries: next,
            highWatermark,
            throughSequence: entry.hubSequence,
            hasMore: true,
          }),
        ).length;
        if (size > maxBytes) break;
        entries.push(entry);
      }
      if (rows.length && entries.length === 0)
        return yield* new M.MemoryHubError({ code: "payload_too_large" });
      const throughSequence = entries.at(-1)?.hubSequence ?? input.afterSequence;
      return { entries, highWatermark, throughSequence, hasMore: rows.length > entries.length };
    },
  );
  const transitionHubLeaseTx: MemoryStoreShape["transitionHubLeaseTx"] = Effect.fn(
    "MemoryStore.transitionHubLeaseTx",
  )(function* (input) {
    yield* Transaction;
    yield* input.authority.reauthorize;
    const member = yield* requireHubMemberTx(input.authority.principal);
    const now = yield* input.authority.now;
    const action = input.action;
    const space = member.memorySpaceId;
    const memoryId = action.kind === "invalidate" ? action.memoryId : action.request.memoryId;
    const current = yield* loadAggregate(
      space,
      memoryId,
      {},
      action.kind === "claim" ? { conflictId: action.request.conflictId } : {},
    );
    const rows = yield* stored(
      "hub-lease",
      sql<{
        highest_token: number;
        lease_json: string | null;
      }>`SELECT * FROM memory_hub_leases WHERE space=${space} AND memory_id=${memoryId}`,
    );
    const lease = rows[0]?.lease_json
      ? yield* codec(M.MemoryResolutionLease).decode(rows[0].lease_json, strict)
      : null;
    const highest = Math.max(rows[0]?.highest_token ?? 0, current.fence?.highestFencingToken ?? 0);
    let next: M.MemoryResolutionLease | null = null;
    let token = highest;
    if (action.kind === "invalidate") {
      if (highest !== action.expectedToken) return null;
      token = highest + 1;
    } else {
      const r = action.request;
      if (r.memorySpaceId !== space || r.holderEnvironmentId !== member.environmentId)
        return yield* new M.MemoryHubForbiddenError({});
      if (action.kind === "claim") {
        const requestDigest = hashText(yield* claimCodec.encode(action.request));
        const attempts = yield* stored(
          "hub-attempt-replay",
          sql<{
            record_json: string;
            memory_id: string;
          }>`SELECT record_json,memory_id FROM memory_import_keys WHERE space=${space} AND key_kind='hub_attempt' AND key=${r.attemptId}`,
        );
        const attempt = attempts[0]
          ? yield* codec(HubAttemptReplay).decode(attempts[0].record_json, strict)
          : null;
        if (attempt) {
          if (attempts[0]!.memory_id !== memoryId || attempt.requestDigest !== requestDigest)
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          if (attempt.deadline <= now)
            return yield* new M.MemoryHubError({ code: "lease_expired" });
          if (lease?.attemptId !== r.attemptId || lease.fencingToken !== attempt.fencingToken)
            return yield* new M.MemoryHubError({ code: "fenced" });
        }
        if (lease?.attemptId === r.attemptId) {
          if (
            Date.parse(lease.expiresAtHubTime) <= now ||
            Date.parse(lease.attemptDeadlineHubTime) <= now
          )
            return yield* new M.MemoryHubError({ code: "lease_expired" });
          if (
            current.tombstone ||
            current.pendingForget ||
            !sameHeadSet(current.heads, lease.conflictHeadSet)
          )
            return yield* new M.MemoryHubError({ code: "conflict_changed" });
          if (
            lease.holderEnvironmentId !== r.holderEnvironmentId ||
            lease.conflictId !== r.conflictId ||
            !sameHeadSet(lease.conflictHeadSet, action.request.conflictHeadSet) ||
            (yield* selectionCodec.encode(lease.frozenDefaultModelSelection)) !==
              (yield* selectionCodec.encode(action.request.frozenDefaultModelSelection))
          )
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          return lease;
        }
        if (lease && Date.parse(lease.expiresAtHubTime) > now)
          return yield* new M.MemoryHubError({ code: "lease_required" });
        if (!current.identity || current.tombstone || current.pendingForget)
          return yield* new M.MemoryHubError({ code: "forgotten" });
        if (
          !sameHeadSet(current.heads, action.request.conflictHeadSet) ||
          !current.conflicts.some((c) => c.conflictId === r.conflictId && c.status !== "resolved")
        )
          return yield* new M.MemoryHubError({ code: "conflict_changed" });
        const count = yield* stored(
          "hub-attempt-count",
          sql<{
            count: number;
          }>`SELECT count(*) AS count FROM memory_import_keys WHERE space=${space} AND key_kind='hub_attempt'`,
        );
        if (count[0]!.count >= M.MEMORY_DEDUP_MAX_RECEIPTS)
          return yield* new MemoryCapacityError({
            dimension: "receipts",
            limit: M.MEMORY_DEDUP_MAX_RECEIPTS,
          });
        token = highest + 1;
        // Permanent bounded guard survives release, invalidate and replacement. Details remain transient.
        yield* stored(
          "hub-attempt-first",
          sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hub_attempt',${r.attemptId},${memoryId},${yield* codec(HubAttemptReplay).encode({ requestDigest, claimedAt: now, deadline: now + M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS, fencingToken: token })})`,
        );
        const iso = (time: number) =>
          M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(time)));
        next = {
          memorySpaceId: space,
          memoryId,
          conflictId: r.conflictId,
          conflictHeadSet: action.request.conflictHeadSet,
          holderEnvironmentId: member.environmentId,
          attemptId: r.attemptId,
          frozenDefaultModelSelection: action.request.frozenDefaultModelSelection,
          fencingToken: token,
          claimedAtHubTime: iso(now),
          expiresAtHubTime: iso(now + M.MEMORY_LEASE_MS),
          attemptDeadlineHubTime: iso(now + M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS),
        };
      } else {
        if (
          !lease ||
          lease.attemptId !== r.attemptId ||
          lease.holderEnvironmentId !== member.environmentId ||
          lease.conflictId !== r.conflictId ||
          lease.fencingToken !== action.request.fencingToken
        )
          return yield* new M.MemoryHubError({ code: "fenced" });
        if (action.kind === "renew") {
          if (
            Date.parse(lease.expiresAtHubTime) <= now ||
            Date.parse(lease.attemptDeadlineHubTime) <= now
          )
            return yield* new M.MemoryHubError({ code: "lease_expired" });
          if (
            current.tombstone ||
            current.pendingForget ||
            !sameHeadSet(current.heads, lease.conflictHeadSet)
          )
            return yield* new M.MemoryHubError({ code: "conflict_changed" });
          next = {
            ...lease,
            expiresAtHubTime: M.MemoryUtcTimestamp.make(
              DateTime.formatIso(
                DateTime.makeUnsafe(
                  Math.min(now + M.MEMORY_LEASE_MS, Date.parse(lease.attemptDeadlineHubTime)),
                ),
              ),
            ),
          };
        }
      }
    }
    if (!current.identity) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const fence: M.MemoryFenceRecord = {
      memorySpaceId: space,
      memoryId,
      highestFencingToken: token,
      activeLease: next,
    };
    yield* stored(
      "hub-lease-update",
      sql`INSERT INTO memory_hub_leases(space,memory_id,highest_token,lease_json) VALUES (${space},${memoryId},${token},${next ? yield* codec(M.MemoryResolutionLease).encode(next) : null}) ON CONFLICT(space,memory_id) DO UPDATE SET highest_token=excluded.highest_token,lease_json=excluded.lease_json`,
    );
    yield* stored(
      "hub-identity-fence",
      sql`UPDATE memory_identity_ledger SET fence_json=${yield* fenceCodec.encode(fence)} WHERE space=${space} AND memory_id=${memoryId}`,
    );
    return action.kind === "release" ? { released: true } : next;
  });
  const settleMetadataEntryTx: MemoryStoreShape["settleMetadataEntryTx"] = Effect.fn(
    "MemoryStore.settleMetadataEntryTx",
  )(function* (input) {
    yield* Transaction;
    const entry = yield* stored("metadata-entry", hubEntryDecode(input.entry, strict));
    if (entry.kind !== "metadata")
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (entry.compactReceipt && entry.compactReceipt.memorySpaceId !== input.memorySpaceId)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const old = yield* receipt(input.memorySpaceId, entry.receipt.operationId);
    if (old && old.operationDigest !== entry.receipt.operationDigest)
      return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
    const settledReceipt = {
      ...entry.receipt,
      ...(old?.receipt.forgetExpansion ? { forgetExpansion: old.receipt.forgetExpansion } : {}),
      ...(old?.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}),
    };
    if (
      old &&
      "hubSequence" in old.receipt &&
      old.receipt.hubSequence !== null &&
      (yield* receiptCodec.encode(old.receipt)) !== (yield* receiptCodec.encode(settledReceipt))
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    // Canonical replay may enrich receipts, but its domain incorporation already happened.
    const canonicalReplay = old && "hubSequence" in old.receipt && old.receipt.hubSequence !== null;
    if (entry.receipt.outcome !== "rejected" && entry.revision) {
      const revision = entry.revision;
      if (
        revision.memorySpaceId !== input.memorySpaceId ||
        revision.memoryId !== entry.memoryId ||
        revision.operationId !== entry.receipt.operationId
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const current = yield* loadAggregate(
        input.memorySpaceId,
        entry.memoryId,
        { revisionIds: [revision.revisionId] },
        {},
      );
      if (current.identity) yield* persistImportLineageTx(lineageForRevision(revision));
      if (
        !canonicalReplay &&
        !current.tombstone &&
        !current.revisions.some(
          (pair) => pair.revision.revisionId === revision.revisionId && pair.payload !== null,
        )
      ) {
        yield* stored(
          "metadata-revision",
          sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${revision.memorySpaceId},${revision.revisionId},${revision.memoryId},${revision.operationId},${yield* headsCodec.encode(revision.parents)},${yield* scopeCodec.encode(revision.scope)},${revision.assertionKind},${yield* provenanceCodec.encode(revision.provenance)},${revision.payloadRef},${Date.parse(revision.createdAtUtc)}) ON CONFLICT(space,revision_id) DO NOTHING`,
        );
        // Preserve unrelated unsent heads; a missing body is a canonical availability state.
        const parents = new Set(revision.parents);
        const heads = [
          ...new Set([...current.heads.filter((id) => !parents.has(id)), revision.revisionId]),
        ];
        const watermark = yield* nextWatermark(input.memorySpaceId);
        yield* putItem(
          {
            memorySpaceId: input.memorySpaceId,
            memoryId: entry.memoryId,
            status: "blocked",
            scope: revision.scope,
            failureCode: "source_invalidated",
            pendingSync: false,
            localAvailability: {
              exposure: "held",
              reasons: ["dependency_invalidated"],
              deferred: [],
              cleanupPending: false,
            },
          },
          heads,
          watermark,
        );
        yield* emit({
          memorySpaceId: input.memorySpaceId,
          memoryId: entry.memoryId,
          kind: "invalidate",
          projectionWatermark: watermark,
        });
      }
    }
    if (entry.tombstone && !canonicalReplay) {
      if (
        entry.tombstone.memorySpaceId !== input.memorySpaceId ||
        entry.tombstone.memoryId !== entry.memoryId
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const t = entry.tombstone;
      const watermark = yield* nextWatermark(input.memorySpaceId);
      yield* stored(
        "metadata-tombstone",
        sql`INSERT INTO memory_tombstones(space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${input.memorySpaceId},${t.memoryId},${t.deleteOperationId},${t.deletingEnvironmentId},${Date.parse(t.deletedAtUtc)},'[]','[]','[]') ON CONFLICT(space,memory_id) DO NOTHING`,
      );
      yield* putItem(
        {
          memorySpaceId: input.memorySpaceId,
          memoryId: t.memoryId,
          status: "forgotten",
          tombstone: t,
          pendingSync: false,
          localAvailability: {
            exposure: "forgotten",
            reasons: [],
            deferred: [],
            cleanupPending: false,
          },
        },
        [],
        watermark,
      );
      yield* emit({
        memorySpaceId: input.memorySpaceId,
        memoryId: t.memoryId,
        kind: "forget",
        projectionWatermark: watermark,
      });
      yield* writeSuppressions(entry.tombstone);
      yield* purge(input.memorySpaceId, entry.memoryId, yield* nextWatermark(input.memorySpaceId));
    }
    yield* stored(
      "metadata-receipt-promotion",
      sql`UPDATE memory_events SET receipt_json=${yield* receiptCodec.encode(settledReceipt)} WHERE memory_space_id=${input.memorySpaceId} AND operation_id=${entry.receipt.operationId}`,
    );
    yield* settleImportOperationTx(input.memorySpaceId, settledReceipt);
    // A compact guard retains body-free approval even when no local operation body remains.
    const existing = yield* stored(
      "metadata-compact",
      sql`UPDATE memory_compact_receipts SET receipt_json=${yield* receiptCodec.encode(settledReceipt)},hub_sequence=${entry.hubSequence} WHERE space=${input.memorySpaceId} AND operation_id=${entry.receipt.operationId} RETURNING operation_id`,
    );
    if (entry.compactReceipt)
      yield* persistCompactReceipt({ ...entry.compactReceipt, receipt: settledReceipt });
    if (!entry.compactReceipt && !old && !existing.length)
      yield* stored(
        "metadata-ledger",
        sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${input.memorySpaceId},'hubReceipt',${entry.receipt.operationId},${entry.memoryId},${yield* hubEntryCodec.encode(entry)}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
      );
  });
  return {
    appendHubEntryTx,
    readHubTailTx,
    transitionHubLeaseTx,
    settleMetadataEntryTx,
  };
};

export type HubWrite = ReturnType<typeof makeHubWrite>;
