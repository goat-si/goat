import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ClaimCandidates } from "./ClaimCandidates.ts";
import type { CoreReads } from "./CoreReads.ts";
import type { RevertIntents } from "./RevertIntents.ts";
import {
  claimCodec,
  codec,
  decodeTicket,
  headsCodec,
  holdRearmResult,
  hubReceiptCodec,
  localMetadataCodec,
  metadataCodec,
  metadataOf,
  payloadCodec,
  receiptCodec,
  selectionCodec,
  stored,
  storedTicketRowCodec,
  workRows,
} from "./StoreCodecs.ts";
import type { WorkRow } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryStorageError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  sameHeadSet,
  strict,
} from "./StoreModel.ts";
import type { TicketKey, TicketOwner, TicketRow } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";
import type { SyncHolds } from "./SyncHolds.ts";
import type { WorkQueue } from "./WorkQueue.ts";

const encodeTicketRow = (row: TicketRow) =>
  storedTicketRowCodec.encode({
    ...row,
    submission: row.submission
      ? {
          ...row.submission,
          operation: metadataOf(row.submission.operation),
        }
      : null,
  });
const submissionMatchesTicket = (
  submission: M.MemoryHubApplyResolutionInput,
  ticket: M.MemoryResolutionLease,
) => {
  const op = submission.operation;
  return (
    op.kind === "resolve" &&
    submission.memorySpaceId === ticket.memorySpaceId &&
    submission.attemptId === ticket.attemptId &&
    submission.holderEnvironmentId === ticket.holderEnvironmentId &&
    op.memorySpaceId === ticket.memorySpaceId &&
    op.memoryId === ticket.memoryId &&
    op.originEnvironmentId === ticket.holderEnvironmentId &&
    op.conflictId === ticket.conflictId &&
    op.fencingToken === ticket.fencingToken &&
    op.resolution.fencingToken === ticket.fencingToken &&
    op.resolution.resolvingEnvironmentId === ticket.holderEnvironmentId &&
    sameHeadSet(op.expectedHeads, ticket.conflictHeadSet) &&
    sameHeadSet(op.revision.parents, ticket.conflictHeadSet) &&
    sameHeadSet(op.resolution.inputRevisionIds, ticket.conflictHeadSet) &&
    JSON.stringify(op.resolution.requestedModelSelection) ===
      JSON.stringify(ticket.frozenDefaultModelSelection)
  );
};
const ticketId = (key: TicketKey) => `resolve:${key.memorySpaceId}:${key.attemptId}`;
const submissionDecode = Schema.decodeUnknownEffect(M.MemoryHubApplyResolutionInput);

export const makeResolutionTickets = (
  kernel: Pick<StoreKernel, "markRunnable" | "sql">,
  coreReads: Pick<CoreReads, "loadAggregate">,
  workQueue: Pick<WorkQueue, "clearTerminalSubmission">,
  claimCandidates: Pick<ClaimCandidates, "unresolvedSubmission">,
  revertIntents: Pick<RevertIntents, "storeUsageForRevert">,
  syncHolds: Pick<SyncHolds, "readHoldRearmPage">,
) => {
  const { markRunnable, sql } = kernel;
  const { loadAggregate } = coreReads;
  const { clearTerminalSubmission } = workQueue;
  const { unresolvedSubmission } = claimCandidates;
  const { storeUsageForRevert } = revertIntents;
  const { readHoldRearmPage } = syncHolds;
  const decodeTicketRow = Effect.fnUntraced(function* (json: string) {
    const row = yield* stored("ticket-decode", storedTicketRowCodec.decode(json, strict));
    if (!row.submission) return { ...row, submission: null };
    const bodies = yield* stored(
      "ticket-body",
      sql<{
        body_json: string;
      }>`SELECT body_json FROM memory_payloads WHERE space=${row.ticket.memorySpaceId} AND payload_ref=${`submission:${row.ticket.attemptId}`}`,
    );
    if (!bodies[0])
      return yield* new MemoryStorageError({ stage: "ticket-payload", cause: undefined });
    const submission = yield* stored(
      "ticket-submission",
      codec(M.MemoryHubApplyResolutionInput).decode(bodies[0].body_json, strict),
    );
    if (
      !submissionMatchesTicket(submission, row.ticket) ||
      hashText(M.encodeMemoryOperation(submission.operation)) !== row.submissionDigest ||
      (yield* metadataCodec.encode(metadataOf(submission.operation))) !==
        (yield* metadataCodec.encode(row.submission.operation))
    )
      return yield* new MemoryStorageError({ stage: "ticket-payload-identity", cause: undefined });
    return { ...row, submission };
  });
  const prepareClaimAttemptTx: MemoryStoreShape["prepareClaimAttemptTx"] = Effect.fn(
    "MemoryStore.prepareClaimAttemptTx",
  )(function* (input) {
    yield* Transaction;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* stored(
      "claim-prepare",
      sql<WorkRow & { sync_version: number; frozen_claim_json: string | null }>`
      SELECT o.* FROM memory_outbox o JOIN memory_items i ON i.space=o.space AND i.memory_id=o.memory_id
      WHERE o.id=${input.candidateId} AND o.space=${input.memorySpaceId} AND o.kind='claim' AND o.sync_version=${input.expectedGeneration}
      AND o.status IN ('pending','retry','running') AND o.next_attempt_at<=${now} AND i.status='quarantined' AND NOT ${unresolvedSubmission(sql.unsafe("o.space"), sql.unsafe("o.memory_id"))}
      AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=i.space AND f.memory_id=i.memory_id)`,
    );
    const row = rows[0];
    if (!row || row.memory_id === null) return null;
    const current = yield* loadAggregate(
      input.memorySpaceId,
      M.MemoryId.make(row.memory_id),
      {},
      {},
    );
    if (
      !sameHeadSet(current.heads, input.conflictHeads) ||
      current.item?.localAvailability.reasons.some((r) =>
        [
          "scanner_pending",
          "secret_detected",
          "missing_parent",
          "dependency_invalidated",
          "forget_pending",
        ].includes(r),
      )
    )
      return null;
    const work = (yield* workRows(rows))[0]!;
    if (work.metadata.kind !== "claim") return null;
    if (row.frozen_claim_json)
      return {
        claim: yield* claimCodec.decode(row.frozen_claim_json, strict),
        generation: row.sync_version,
      };
    if (!input.proposedClaim) return null;
    const claim = yield* stored(
      "claim-input",
      claimCodec.decode(yield* claimCodec.encode(input.proposedClaim), strict),
    );
    if (
      claim.memorySpaceId !== input.memorySpaceId ||
      claim.memoryId !== row.memory_id ||
      claim.conflictId !== work.metadata.conflictId ||
      !sameHeadSet(claim.conflictHeadSet, input.conflictHeads)
    )
      return yield* new MemoryStoreConflict({ code: "conflict_changed" });
    const claimed = yield* stored(
      "claim-persist",
      sql`UPDATE memory_outbox SET frozen_claim_json=${yield* claimCodec.encode(claim)} WHERE id=${input.candidateId} AND sync_version=${input.expectedGeneration} AND frozen_claim_json IS NULL RETURNING id`,
    );
    return claimed.length ? { claim, generation: input.expectedGeneration } : null;
  });
  const readRecoverableResolutionTickets: MemoryStoreShape["readRecoverableResolutionTickets"] =
    Effect.fn("MemoryStore.readRecoverableResolutionTickets")(function* (input) {
      const rows = yield* stored(
        "ticket-recovery",
        sql<{
          ticket_json: string;
        }>`SELECT ticket_json FROM memory_outbox WHERE space=${input.memorySpaceId} AND kind='resolve' AND status NOT IN ('cancelled','completed','failed') AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=memory_outbox.space AND t.memory_id=memory_outbox.memory_id) AND ticket_json IS NOT NULL AND json_extract(ticket_json,'$.state')!='terminal' AND json_extract(ticket_json,'$.nextAttemptAt')<=${input.now} AND (json_extract(ticket_json,'$.ownedUntil') IS NULL OR json_extract(ticket_json,'$.ownedUntil')<=${input.now}) ORDER BY next_attempt_at,id LIMIT ${Math.max(0, Math.min(input.limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
      );
      return yield* Effect.forEach(rows, (row) => decodeTicketRow(row.ticket_json));
    });
  const readTicket = Effect.fnUntraced(function* (key: TicketKey) {
    const rows = yield* stored(
      "ticket-read",
      sql<{
        ticket_json: string | null;
      }>`SELECT ticket_json FROM memory_outbox WHERE id=${ticketId(key)} AND status NOT IN ('cancelled','completed','failed') AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=memory_outbox.space AND t.memory_id=memory_outbox.memory_id)`,
    );
    return rows[0]?.ticket_json ? yield* decodeTicketRow(rows[0].ticket_json) : null;
  });
  const ownedTicket = Effect.fnUntraced(function* (o: TicketOwner, now: number) {
    const row = yield* readTicket(o);
    return row &&
      row.state !== "terminal" &&
      row.version === o.version &&
      row.owner === o.owner &&
      row.coordinatorEpoch === o.coordinatorEpoch &&
      row.ownedUntil !== null &&
      row.ownedUntil > now
      ? row
      : null;
  });
  const writeTicket = Effect.fnUntraced(function* (
    key: TicketKey,
    row: TicketRow,
    expectedVersion: number,
  ) {
    const changed = yield* stored(
      "ticket-write",
      sql`UPDATE memory_outbox SET ticket_json=${yield* encodeTicketRow(row)},sync_version=${row.version},next_attempt_at=${row.nextAttemptAt} WHERE id=${ticketId(key)} AND sync_version=${expectedVersion} RETURNING id`,
    );
    return changed.length ? row : null;
  });
  const acquireResolutionTicketTx: MemoryStoreShape["acquireResolutionTicketTx"] = Effect.fn(
    "MemoryStore.acquireResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* readTicket(input.key);
    if (
      !row ||
      row.state === "terminal" ||
      row.version !== input.expectedVersion ||
      row.nextAttemptAt > input.now ||
      (row.ownedUntil !== null && row.ownedUntil > input.now) ||
      input.ownedUntil <= input.now
    )
      return null;
    return yield* writeTicket(
      input.key,
      {
        ...row,
        version: row.version + 1,
        owner: input.owner,
        coordinatorEpoch: input.coordinatorEpoch,
        ownedUntil: input.ownedUntil,
      },
      row.version,
    );
  });
  const transitionResolutionTicketTx: MemoryStoreShape["transitionResolutionTicketTx"] = Effect.fn(
    "MemoryStore.transitionResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    if (!row) return null;
    if (input.retireClaim) {
      const definitiveRejected =
        input.approval?.outcome === "rejected" &&
        row.submission !== null &&
        input.approval.operationId === row.submission.operation.operationId &&
        input.approval.memoryId === row.ticket.memoryId &&
        input.approval.operationDigest === row.submissionDigest &&
        (!row.approval ||
          (row.approval.outcome === "rejected" &&
            row.approval.operationDigest === input.approval.operationDigest &&
            row.approval.operationId === input.approval.operationId));
      if (
        input.nextState !== "terminal" ||
        input.retireClaim.attemptId !== row.ticket.attemptId ||
        ((row.approval || input.approval || row.state === "submitting") && !definitiveRejected)
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      const retired = yield* stored(
        "claim-retire",
        sql`UPDATE memory_outbox SET frozen_claim_json=NULL,sync_version=sync_version+1,status='retry',claimed_by=NULL,claimed_until=NULL,next_attempt_at=${input.nextAttemptAt}
        WHERE space=${input.ownership.memorySpaceId} AND kind='claim' AND ${input.retireClaim.candidateId === undefined ? sql`1` : sql`id=${input.retireClaim.candidateId}`} AND sync_version=${input.retireClaim.expectedGeneration}
        AND json_extract(frozen_claim_json,'$.attemptId')=${input.retireClaim.attemptId} RETURNING id`,
      );
      if (retired.length !== 1) return null;
    }
    const next: TicketRow = {
      ...row,
      state: input.nextState,
      version: row.version + 1,
      ownedUntil: input.ownedUntil,
      nextAttemptAt: input.nextAttemptAt,
      approval: input.approval ?? row.approval,
      owner: input.ownedUntil === null ? null : row.owner,
    };
    const updated = yield* writeTicket(input.ownership, next, row.version);
    if (updated && input.nextState === "terminal") {
      yield* clearTerminalSubmission(ticketId(input.ownership));
      yield* stored(
        "terminal-resolution-work",
        sql`UPDATE memory_outbox SET status=${updated.approval?.outcome === "rejected" ? "failed" : "completed"},terminal_at=${input.now} WHERE id=${ticketId(input.ownership)}`,
      );
      return {
        ...updated,
        state: "terminal" as const,
        version: updated.version + 1,
        submission: null,
        submissionDigest: null,
        owner: null,
        ownedUntil: null,
      };
    }
    return updated;
  });
  const reconcileResolutionSubmissionTx: MemoryStoreShape["reconcileResolutionSubmissionTx"] =
    Effect.fn("MemoryStore.reconcileResolutionSubmissionTx")(function* (input) {
      yield* Transaction;
      const row = yield* ownedTicket(input.ownership, input.now);
      if (!row?.submission || !row.submissionDigest) return null;
      const op = row.submission.operation;
      // All receipt sources are uniquely keyed by (space, operationId). Absence is uncertainty,
      // including compacted/offline logs; a changed frontier alone is never negative proof.
      const receipts = yield* stored(
        "resolution-admission-keyed",
        sql<{ operation_digest: string; receipt_json: string }>`
        SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${input.ownership.memorySpaceId} AND operation_id=${op.operationId}
        UNION ALL SELECT operation_digest,receipt_json FROM memory_compact_receipts WHERE space=${input.ownership.memorySpaceId} AND operation_id=${op.operationId}
        UNION ALL SELECT json_extract(record_json,'$.receipt.operationDigest'),json_extract(record_json,'$.receipt') FROM memory_import_keys WHERE space=${input.ownership.memorySpaceId} AND key_kind='hubReceipt' AND key=${op.operationId} LIMIT 3`,
      );
      let admitted: M.MemoryHubReceipt | undefined;
      for (const canonical of receipts) {
        if (canonical.operation_digest !== row.submissionDigest)
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        const value = yield* receiptCodec.decode(canonical.receipt_json, strict);
        if ("hubSequence" in value) {
          if (
            admitted &&
            (yield* hubReceiptCodec.encode(admitted)) !== (yield* hubReceiptCodec.encode(value))
          )
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          admitted = value;
        }
      }
      const evidence = admitted ?? row.approval ?? input.rejection;
      const result = evidence
        ? yield* hubReceiptCodec.decode(yield* hubReceiptCodec.encode(evidence), strict)
        : undefined;
      if (!result) return { outcome: "uncertain" as const, row };
      if (
        result.operationId !== op.operationId ||
        result.memoryId !== row.ticket.memoryId ||
        result.operationDigest !== row.submissionDigest ||
        !M.validateMemoryResolutionApproval(
          op.kind,
          op.kind === "resolve" ? op.resolution.resolutionId : null,
          result,
        )
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (
        input.rejection &&
        (input.rejection.outcome !== "rejected" ||
          input.rejection.operationId !== op.operationId ||
          input.rejection.operationDigest !== row.submissionDigest ||
          input.rejection.memoryId !== row.ticket.memoryId)
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (result.outcome !== "rejected") {
        if (result.hubSequence === null)
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const updated = yield* writeTicket(
          input.ownership,
          { ...row, state: "approved", approval: result, version: row.version + 1 },
          row.version,
        );
        return updated ? { outcome: "admitted" as const, row: updated, receipt: result } : null;
      }
      if (row.approval && row.approval.outcome !== "rejected")
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const candidateId = `claim:${row.ticket.memorySpaceId}:${row.ticket.memoryId}:${hashText(yield* headsCodec.encode(row.ticket.conflictHeadSet))}`;
      yield* stored(
        "reconcile-rejected-claim",
        sql`UPDATE memory_outbox SET frozen_claim_json=NULL,sync_version=sync_version+1,status='retry',terminal_at=NULL,claimed_by=NULL,claimed_until=NULL,next_attempt_at=${input.now} WHERE id=${candidateId} AND kind='claim' AND json_extract(frozen_claim_json,'$.attemptId')=${row.ticket.attemptId}`,
      );
      const updated = yield* transitionResolutionTicketTx({
        ownership: input.ownership,
        now: input.now,
        nextState: "terminal",
        ownedUntil: null,
        nextAttemptAt: input.now,
        approval: result,
      });
      if (!updated) return yield* new MemoryStoreConflict({ code: "fenced" });
      return { outcome: "retired" as const, row: updated };
    });
  const retireRejectedSubmissionTx: MemoryStoreShape["retireRejectedSubmissionTx"] = Effect.fn(
    "MemoryStore.retireRejectedSubmissionTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    if (!row) return null;
    const rejection = yield* hubReceiptCodec.decode(
      yield* hubReceiptCodec.encode(input.rejection),
      strict,
    );
    if (
      rejection.outcome !== "rejected" ||
      !row.submission ||
      rejection.operationId !== row.submission.operation.operationId ||
      rejection.memoryId !== row.ticket.memoryId ||
      rejection.operationDigest !== row.submissionDigest ||
      (row.approval && row.approval.outcome !== "rejected") ||
      input.nextAttemptAt < input.now
    )
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    return yield* transitionResolutionTicketTx({
      ownership: input.ownership,
      nextState: "terminal",
      now: input.now,
      ownedUntil: null,
      nextAttemptAt: input.nextAttemptAt,
      approval: rejection,
      retireClaim: {
        candidateId: input.candidateId,
        expectedGeneration: input.expectedGeneration,
        attemptId: row.ticket.attemptId,
      },
    });
  });
  const renewResolutionTicketTx: MemoryStoreShape["renewResolutionTicketTx"] = Effect.fn(
    "MemoryStore.renewResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    if (
      !row ||
      row.state === "terminal" ||
      row.ticket.expiresAtHubTime !== input.expectedExpiresAtHubTime
    )
      return null;
    const renewed = yield* stored("renewed-ticket-codec", decodeTicket(input.renewedLease, strict));
    const old = row.ticket;
    if (
      renewed.memorySpaceId !== old.memorySpaceId ||
      renewed.memoryId !== old.memoryId ||
      renewed.conflictId !== old.conflictId ||
      renewed.attemptId !== old.attemptId ||
      renewed.holderEnvironmentId !== old.holderEnvironmentId ||
      renewed.fencingToken !== old.fencingToken ||
      renewed.claimedAtHubTime !== old.claimedAtHubTime ||
      renewed.attemptDeadlineHubTime !== old.attemptDeadlineHubTime ||
      !sameHeadSet(renewed.conflictHeadSet, old.conflictHeadSet) ||
      (yield* selectionCodec.encode(renewed.frozenDefaultModelSelection)) !==
        (yield* selectionCodec.encode(old.frozenDefaultModelSelection)) ||
      Date.parse(renewed.expiresAtHubTime) < Date.parse(old.expiresAtHubTime)
    )
      return yield* new MemoryStoreConflict({ code: "fenced" });
    return yield* writeTicket(
      input.ownership,
      { ...row, ticket: renewed, version: row.version + 1 },
      row.version,
    );
  });
  const failResolutionTicketTx: MemoryStoreShape["failResolutionTicketTx"] = Effect.fn(
    "MemoryStore.failResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    if (!row || row.state === "terminal" || row.approval) return null;
    if (
      input.nextAttemptAt < input.now ||
      (input.nextAttemptAt === Number.MAX_SAFE_INTEGER) !== (input.holdClass !== undefined)
    )
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    // An uncertain submission is preserved and is never announced as a failed conflict.
    if (input.reportConflictFailure && row.submission)
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const next = yield* writeTicket(
      input.ownership,
      {
        ...row,
        version: row.version + 1,
        state: row.submission ? "submitting" : "recoverable",
        owner: null,
        ownedUntil: null,
        nextAttemptAt: input.nextAttemptAt,
      },
      row.version,
    );
    if (!next) return null;
    yield* stored(
      "ticket-failure",
      sql`UPDATE memory_outbox SET hold_class=${input.holdClass ?? null},failure_code=${input.failureCode} WHERE id=${ticketId(input.ownership)} AND sync_version=${next.version}`,
    );
    if (input.reportConflictFailure) {
      const reportId = hashText(
        `${row.ticket.memorySpaceId}:${row.ticket.attemptId}:conflict-failed`,
      );
      yield* stored(
        "conflict-failure-report",
        sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
        SELECT ${reportId},${row.ticket.memorySpaceId},${row.ticket.memoryId},${row.ticket.attemptId},NULL,${row.ticket.attemptId},${row.ticket.holderEnvironmentId},'failed','pending',${input.failureCode},${input.now},'conflict_failure',1,1
        WHERE NOT EXISTS (SELECT 1 FROM memory_import_keys WHERE space=${row.ticket.memorySpaceId} AND key_kind='report_delivered' AND key=${reportId}) ON CONFLICT(report_id) DO NOTHING`,
      );
      yield* markRunnable;
    }
    return next;
  });
  const holdClaimCandidateTx: MemoryStoreShape["holdClaimCandidateTx"] = Effect.fn(
    "MemoryStore.holdClaimCandidateTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* stored(
      "claim-hold",
      sql`UPDATE memory_outbox SET status='retry',hold_class=${input.holdClass},failure_code=${input.failureCode},next_attempt_at=${Number.MAX_SAFE_INTEGER},claimed_by=NULL,claimed_until=NULL
      WHERE id=${input.candidateId} AND space=${input.memorySpaceId} AND kind='claim' AND status='running' AND sync_version=${input.expectedGeneration}
      AND attempt=${input.expectedAttempt} AND json_extract(frozen_claim_json,'$.attemptId')=${input.attemptId} AND claimed_by=${String(input.coordinatorEpoch)} AND claimed_until>${input.now} RETURNING id`,
    );
    return rows.length === 1;
  });
  const holdResolutionAttemptTx: MemoryStoreShape["holdResolutionAttemptTx"] = Effect.fn(
    "MemoryStore.holdResolutionAttemptTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    // Submitted work needs reconciliation. A permanent refusal must never retire its
    // frozen attempt or manufacture a failure report, including approval-only rows.
    if (!row || row.submission || row.submissionDigest || row.approval) return null;
    const candidateId = `claim:${row.ticket.memorySpaceId}:${row.ticket.memoryId}:${hashText(yield* headsCodec.encode(row.ticket.conflictHeadSet))}`;
    if (input.candidateId !== candidateId) return null;
    const changed = yield* stored(
      "resolution-attempt-hold",
      sql`UPDATE memory_outbox SET status='retry',hold_class=${input.holdClass},failure_code=${input.failureCode},next_attempt_at=${Number.MAX_SAFE_INTEGER},claimed_by=NULL,claimed_until=NULL
      WHERE id=${input.candidateId} AND space=${row.ticket.memorySpaceId} AND memory_id=${row.ticket.memoryId} AND kind='claim'
      AND sync_version=${input.expectedGeneration} AND attempt=${input.expectedAttempt}
      AND json_extract(frozen_claim_json,'$.attemptId')=${row.ticket.attemptId}
      AND ((status='running' AND claimed_by=${String(input.ownership.coordinatorEpoch)} AND claimed_until>${input.now})
        OR (status='retry' AND claimed_by IS NULL AND claimed_until IS NULL)) RETURNING id`,
    );
    if (changed.length !== 1) return null;
    const held = yield* failResolutionTicketTx({
      ownership: input.ownership,
      now: input.now,
      failureCode: input.failureCode,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      holdClass: input.holdClass,
      reportConflictFailure: false,
    });
    // Fail, rather than return null, after the first write so the enclosing Tx rolls
    // both rows back if the ticket CAS unexpectedly loses its fence.
    if (!held) return yield* new MemoryStoreConflict({ code: "fenced" });
    return held;
  });
  const rearmResolutionHoldsTx: MemoryStoreShape["rearmResolutionHoldsTx"] = Effect.fn(
    "MemoryStore.rearmResolutionHoldsTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* readHoldRearmPage(input.afterId, input.limit);
    const changed: string[] = [];
    for (const row of rows) {
      if (
        row.space !== input.memorySpaceId ||
        !["claim", "resolve"].includes(row.kind) ||
        ["cancelled", "completed", "failed"].includes(row.status) ||
        row.next_attempt_at !== Number.MAX_SAFE_INTEGER ||
        row.hold_class !== input.holdClass
      )
        continue;
      if (row.kind === "resolve") {
        const tickets = yield* stored(
          "held-ticket",
          sql<{
            ticket_json: string | null;
          }>`SELECT ticket_json FROM memory_outbox WHERE id=${row.id}`,
        );
        if (!tickets[0]?.ticket_json) continue;
        // Rearm is scheduling-only. Decode persisted metadata without reading uncertain
        // submission bodies; retain that metadata and digest byte-for-byte in the next row.
        const ticket = yield* stored(
          "held-ticket-metadata",
          storedTicketRowCodec.decode(tickets[0].ticket_json, strict),
        );
        if (
          ticket.state === "terminal" ||
          ticket.approval ||
          (ticket.ownedUntil !== null && ticket.ownedUntil > input.now)
        )
          continue;
        const next = {
          ...ticket,
          version: ticket.version + 1,
          owner: null,
          ownedUntil: null,
          nextAttemptAt: input.now,
        };
        const advanced = yield* stored(
          "held-ticket-rearm",
          sql`UPDATE memory_outbox SET ticket_json=${yield* storedTicketRowCodec.encode(next)},sync_version=${next.version},next_attempt_at=${input.now}
          WHERE id=${row.id} AND sync_version=${ticket.version} RETURNING id`,
        );
        if (!advanced.length) continue;
      }
      const updated = yield* stored(
        "resolution-hold-rearm",
        sql`UPDATE memory_outbox SET hold_class=NULL,failure_code=NULL,next_attempt_at=${input.now},claimed_by=NULL,claimed_until=NULL WHERE id=${row.id} AND hold_class=${input.holdClass} RETURNING id`,
      );
      if (updated.length) changed.push(row.id);
    }
    return holdRearmResult(rows, changed, input.limit);
  });
  const persistResolutionSubmissionTx: MemoryStoreShape["persistResolutionSubmissionTx"] =
    Effect.fn("MemoryStore.persistResolutionSubmissionTx")(function* (input) {
      yield* Transaction;
      const row = yield* ownedTicket(input.ownership, yield* Clock.currentTimeMillis);
      if (!row) return yield* new MemoryStoreConflict({ code: "fenced" });
      const submission = yield* stored(
        "submission-codec",
        submissionDecode(input.submission, strict),
      );
      if (
        !submissionMatchesTicket(submission, row.ticket) ||
        hashText(M.encodeMemoryOperation(submission.operation)) !== input.digest
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (
        row.submission &&
        (row.submissionDigest !== input.digest ||
          (yield* codec(M.MemoryHubApplyResolutionInput).encode(row.submission)) !==
            (yield* codec(M.MemoryHubApplyResolutionInput).encode(submission)))
      )
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      if (row.submission) return row;
      const op = submission.operation;
      if (op.kind !== "resolve")
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const payloadRef = `submission:${row.ticket.attemptId}`;
      const body = yield* codec(M.MemoryHubApplyResolutionInput).encode(submission);
      const usage = yield* storeUsageForRevert(op.memorySpaceId);
      if (usage.bytes + new TextEncoder().encode(body).length > M.MEMORY_WORK_MAX_PAYLOAD_BYTES)
        return yield* new MemoryStoreConflict({ code: "capacity_exceeded" });
      yield* stored(
        "submission-body",
        sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json,purge_eligible_after) VALUES (${op.memorySpaceId},${payloadRef},${op.memoryId},${body},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)},${Date.parse(row.ticket.attemptDeadlineHubTime) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS})`,
      );
      yield* stored(
        "submission-ref",
        sql`UPDATE memory_outbox SET payload_ref=${payloadRef} WHERE id=${ticketId(input.ownership)} AND sync_version=${row.version}`,
      );
      const updated = yield* writeTicket(
        input.ownership,
        {
          ...row,
          state: "submitting",
          version: row.version + 1,
          submission,
          submissionDigest: input.digest,
        },
        row.version,
      );
      if (!updated) return yield* new MemoryStoreConflict({ code: "fenced" });
      return updated;
    });
  const listMaterializableIntents: MemoryStoreShape["listMaterializableIntents"] = Effect.fn(
    "MemoryStore.listMaterializableIntents",
  )(function* (environment, limit) {
    const rows = yield* stored(
      "intent-list",
      sql<{
        metadata_json: string;
        body_json: string;
      }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.space=${`_local:${environment}`} AND o.kind='admin' AND o.status IN ('pending','retry') AND json_extract(o.metadata_json,'$.kind')='localIntent' ORDER BY o.id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const {
          kind: _kind,
          mapping: _mapping,
          ...intent
        } = yield* localMetadataCodec.decode(row.metadata_json, strict);
        return { ...intent, payload: yield* payloadCodec.decode(row.body_json, strict) };
      }),
    );
  });
  const assignIntentIdentityTx: MemoryStoreShape["assignIntentIdentityTx"] = Effect.fn(
    "MemoryStore.assignIntentIdentityTx",
  )(function* (input) {
    yield* Transaction;
    const id = `local:${input.environmentId}:${input.intentId}`;
    const rows = yield* stored(
      "intent-assign",
      sql<{
        metadata_json: string;
        body_json: string;
      }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.id=${id} AND o.status!='cancelled'`,
    );
    if (!rows[0]) return yield* new MemoryStoreConflict({ code: "not_found" });
    const metadata = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
    if (metadata.environmentId !== input.environmentId)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const mapping = metadata.mapping ?? {
      memorySpaceId: input.memorySpaceId,
      operationId: input.operationId,
      revisionId: input.revisionId,
    };
    if (mapping.memorySpaceId !== input.memorySpaceId)
      return yield* new MemoryStoreConflict({ code: "space_mismatch" });
    if (!metadata.mapping)
      yield* stored(
        "intent-assigned",
        sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ ...metadata, mapping })} WHERE id=${id}`,
      );
    const { kind: _kind, mapping: _mapping, ...intent } = metadata;
    return {
      ...mapping,
      intent: { ...intent, payload: yield* payloadCodec.decode(rows[0].body_json, strict) },
    };
  });
  return {
    prepareClaimAttemptTx,
    readRecoverableResolutionTickets,
    acquireResolutionTicketTx,
    transitionResolutionTicketTx,
    reconcileResolutionSubmissionTx,
    retireRejectedSubmissionTx,
    renewResolutionTicketTx,
    failResolutionTicketTx,
    holdClaimCandidateTx,
    holdResolutionAttemptTx,
    rearmResolutionHoldsTx,
    persistResolutionSubmissionTx,
    listMaterializableIntents,
    assignIntentIdentityTx,
  };
};

export type ResolutionTickets = ReturnType<typeof makeResolutionTickets>;
