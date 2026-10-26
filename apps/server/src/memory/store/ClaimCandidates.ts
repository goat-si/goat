import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import {
  codec,
  decodeTicket,
  headsCodec,
  projectionCodec,
  stored,
  storedTicketRowCodec,
  workRows,
} from "./StoreCodecs.ts";
import type { WorkRow } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { TicketRowSchema, hashText, sameHeadSet, strict } from "./StoreModel.ts";
import type { TicketRow } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";
import type { WorkQueue } from "./WorkQueue.ts";

export const makeClaimCandidates = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "readPending">,
  itemWrites: Pick<ItemWrites, "enqueueWork">,
  workQueue: Pick<WorkQueue, "clearTerminalSubmission" | "finishWork" | "readWork">,
) => {
  const { sql, transact } = kernel;
  const { readPending } = coreReads;
  const { enqueueWork } = itemWrites;
  const { clearTerminalSubmission, finishWork, readWork } = workQueue;
  const unresolvedSubmission = (
    space: string | ReturnType<typeof sql.unsafe>,
    memoryId: string | ReturnType<typeof sql.unsafe>,
  ) => sql`EXISTS (
    SELECT 1 FROM memory_outbox r WHERE r.space=${space} AND r.memory_id=${memoryId}
    AND r.kind='resolve' AND r.status IN ('pending','retry','running')
    AND (json_extract(r.ticket_json,'$.submission') IS NOT NULL
      OR json_extract(r.ticket_json,'$.approval.outcome') != 'rejected') LIMIT 1
  )`;
  const readDueClaimCandidates = Effect.fn("MemoryStore.readDueClaimCandidates")(function* (
    limit: number,
    now: number,
    memorySpaceId: M.MemorySpaceId,
  ) {
    return yield* workRows(
      yield* stored(
        "claim-candidates",
        sql<WorkRow>`SELECT o.* FROM memory_outbox o JOIN memory_items i ON i.space=o.space AND i.memory_id=o.memory_id WHERE o.space=${memorySpaceId} AND o.kind='claim' AND o.status IN ('pending','retry') AND o.next_attempt_at<=${now} AND i.status='quarantined' AND NOT ${unresolvedSubmission(sql.unsafe("o.space"), sql.unsafe("o.memory_id"))} AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=i.space AND f.memory_id=i.memory_id) AND NOT EXISTS (SELECT 1 FROM json_each(i.availability_json,'$.reasons') r WHERE r.value IN ('scanner_pending','secret_detected','missing_parent','dependency_invalidated','forget_pending')) ORDER BY o.next_attempt_at,o.id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
      ),
    );
  });
  const findClaimCandidate: MemoryStoreShape["findClaimCandidate"] = Effect.fn(
    "MemoryStore.findClaimCandidate",
  )(function* (input) {
    let candidateId = input.candidateId;
    if (candidateId === undefined) {
      const tickets = yield* stored(
        "claim-ticket-key",
        sql<{
          ticket_json: string | null;
        }>`SELECT ticket_json FROM memory_outbox WHERE id=${`resolve:${input.memorySpaceId}:${input.attemptId}`} AND space=${input.memorySpaceId}`,
      );
      if (!tickets[0]?.ticket_json) return null;
      const row = yield* storedTicketRowCodec.decode(tickets[0].ticket_json, strict);
      candidateId = `claim:${input.memorySpaceId}:${row.ticket.memoryId}:${hashText(yield* headsCodec.encode(row.ticket.conflictHeadSet))}`;
    }
    const rows = yield* stored(
      "claim-keyed",
      sql<WorkRow>`SELECT o.* FROM memory_outbox o WHERE o.id=${candidateId} AND o.space=${input.memorySpaceId} AND o.kind='claim' AND json_extract(o.frozen_claim_json,'$.attemptId')=${input.attemptId}`,
    );
    return (yield* workRows(rows))[0] ?? null;
  });
  const recoverClaimCandidates = Effect.fn("MemoryStore.recoverClaimCandidates")(function* (
    now: number,
  ) {
    yield* transact(
      Effect.gen(function* () {
        // Each sweep freezes its tail for a cycle, so continuously appended rows
        // cannot postpone revisiting an older frontier or orphan forever.
        const advance = (dimension: string, value: number) =>
          stored(
            "claim-sweep-advance",
            sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES ('_claim_recovery',${dimension},'',${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
          );
        const sweep = Effect.fnUntraced(function* (
          dimension: string,
          table: "memory_items" | "memory_outbox",
        ) {
          const rows = yield* stored(
            "claim-sweep-cursor",
            sql<{
              dimension: string;
              value: number;
            }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_claim_recovery' AND dimension IN (${dimension},${`${dimension}_upper`}) AND scope_key=''`,
          );
          let after = rows.find((r) => r.dimension === dimension)?.value ?? 0;
          let upper = rows.find((r) => r.dimension === `${dimension}_upper`)?.value ?? 0;
          if (after >= upper) {
            after = 0;
            const tail = yield* stored(
              "claim-sweep-upper",
              sql.unsafe<{ rowid: number }>(
                `SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT 1`,
              ),
            );
            upper = tail[0]?.rowid ?? 0;
            yield* advance(`${dimension}_upper`, upper);
          }
          return { after, upper };
        });
        const cancel = Effect.fnUntraced(function* (id: string) {
          const tickets = yield* stored(
            "claim-recovery-ticket",
            sql<{
              ticket_json: string;
            }>`SELECT ticket_json FROM memory_outbox WHERE id=${id} AND kind='resolve' AND ticket_json IS NOT NULL`,
          );
          if (tickets[0]) {
            const row = yield* storedTicketRowCodec.decode(tickets[0].ticket_json, strict);
            if (row.submission || (row.approval && row.approval.outcome !== "rejected")) {
              if (!row.reconcileRequired) {
                // Recovery invalidates generation, never the durable result. Do not hydrate bodies.
                yield* stored(
                  "claim-recovery-reconcile",
                  sql`UPDATE memory_outbox SET ticket_json=${yield* storedTicketRowCodec.encode({ ...row, reconcileRequired: true, version: row.version + 1 })},sync_version=sync_version+1 WHERE id=${id} AND sync_version=${row.version}`,
                );
              }
              return;
            }
          }
          yield* clearTerminalSubmission(id);
          yield* stored(
            "claim-cancel",
            sql`UPDATE memory_outbox SET status='cancelled',claimed_by=NULL,claimed_until=NULL,terminal_at=${now},sync_version=sync_version+CASE WHEN kind='claim' THEN 1 ELSE 0 END WHERE id=${id}`,
          );
        });
        const frontier = yield* sweep("frontier", "memory_items");
        const rows = yield* stored(
          "claim-frontiers",
          sql<{
            rowid: number;
            space: string;
            memory_id: string;
            item_json: string;
          }>`SELECT rowid,space,memory_id,item_json FROM memory_items WHERE rowid>${frontier.after} AND rowid<=${frontier.upper} ORDER BY rowid LIMIT ${M.MEMORY_PAGE_MAX_ITEMS}`,
        );
        yield* advance("frontier", rows.at(-1)?.rowid ?? frontier.upper);
        for (const row of rows) {
          const item = yield* projectionCodec.decode(row.item_json, strict);
          const unusable = item.localAvailability.reasons.some((r) =>
            [
              "scanner_pending",
              "secret_detected",
              "missing_parent",
              "dependency_invalidated",
              "forget_pending",
            ].includes(r),
          );
          const eligible =
            item.status === "quarantined" &&
            !unusable &&
            !(yield* readPending(item.memorySpaceId, item.memoryId));
          const work = yield* stored(
            "claim-frontier-work",
            sql<WorkRow>`SELECT * FROM memory_outbox WHERE space=${row.space} AND memory_id=${row.memory_id} AND kind IN ('claim','resolve') AND status NOT IN ('completed','cancelled','failed') ORDER BY id LIMIT ${M.MEMORY_WORK_MAX_PENDING_ITEMS}`,
          );
          for (const candidate of yield* workRows(work)) {
            const heads =
              candidate.metadata.kind === "claim"
                ? candidate.metadata.sortedHeads
                : candidate.metadata.kind === "resolve" && "ticket" in candidate.metadata
                  ? candidate.metadata.ticket.conflictHeadSet
                  : [];
            if (
              !eligible ||
              item.status !== "quarantined" ||
              !sameHeadSet(heads, item.conflict.heads)
            )
              yield* cancel(candidate.id);
            else if (
              candidate.kind === "claim" &&
              candidate.status === "running" &&
              candidate.claimedUntil !== null &&
              candidate.claimedUntil <= now
            ) {
              yield* stored(
                "claim-recovery",
                sql`UPDATE memory_outbox SET status='retry',claimed_by=NULL,claimed_until=NULL WHERE id=${candidate.id}`,
              );
            }
          }
          if (!eligible || item.status !== "quarantined") continue;
          if (
            (yield* stored(
              "claim-recovery-barrier",
              sql`SELECT 1 WHERE ${unresolvedSubmission(row.space, row.memory_id)}`,
            )).length
          )
            continue;
          const headSetDigest = hashText(yield* headsCodec.encode(item.conflict.heads));
          const candidateId = `claim:${row.space}:${row.memory_id}:${headSetDigest}`;
          // An exposure hold can clear without changing heads. Its cancelled
          // attempt stays fenced, but the eligible frontier may start a new one.
          yield* stored(
            "claim-rearm",
            sql`UPDATE memory_outbox SET status='pending',frozen_claim_json=NULL,sync_version=sync_version+1,terminal_at=NULL,next_attempt_at=${now},claimed_by=NULL,claimed_until=NULL WHERE id=${candidateId} AND kind='claim' AND status='cancelled'`,
          );
          yield* enqueueWork({
            id: candidateId,
            space: row.space,
            memoryId: item.memoryId,
            kind: "claim",
            status: "pending",
            metadata: {
              kind: "claim",
              conflictId: item.conflict.conflictId,
              sortedHeads: item.conflict.heads,
              headSetDigest,
            },
            payloadRef: null,
            attempt: 0,
            nextAttemptAt: now,
            claimedBy: null,
            claimedUntil: null,
          });
        }
        const orphan = yield* sweep("orphan", "memory_outbox");
        // Bound inspected history before filtering kinds. Unrelated rows still
        // advance the frozen cursor but never reach the work metadata decoder.
        const work = yield* stored(
          "claim-gone",
          sql<{
            rowid: number;
            id: string | null;
            gone: number;
          }>`WITH page AS MATERIALIZED (
            SELECT rowid FROM memory_outbox WHERE rowid>${orphan.after} AND rowid<=${orphan.upper}
            ORDER BY rowid LIMIT ${M.MEMORY_PAGE_MAX_ITEMS}
          ) SELECT page.rowid,o.id,NOT EXISTS(SELECT 1 FROM memory_items i WHERE i.space=o.space AND i.memory_id=o.memory_id) AS gone
          FROM page LEFT JOIN memory_outbox o ON o.rowid=page.rowid AND o.kind IN ('claim','resolve')
          ORDER BY page.rowid`,
        );
        yield* advance("orphan", work.at(-1)?.rowid ?? orphan.upper);
        for (const row of work)
          if (row.id !== null && row.gone) {
            const candidate = yield* readWork(row.id);
            if (
              candidate &&
              ["claim", "resolve"].includes(candidate.kind) &&
              !["completed", "cancelled", "failed"].includes(candidate.status)
            )
              yield* cancel(row.id);
          }
      }),
    );
  });
  const claimCandidate = Effect.fn("MemoryStore.claimCandidate")(function* (
    id: string,
    epoch: number,
    now: number,
  ) {
    const rows = yield* stored(
      "claim-cas",
      sql`UPDATE memory_outbox SET status='running',claimed_by=${String(epoch)},claimed_until=${now + M.MEMORY_LEASE_MS},attempt=attempt+1 WHERE id=${id} AND attempt<2147483647 AND kind='claim' AND status IN ('pending','retry') AND next_attempt_at<=${now} AND NOT ${unresolvedSubmission(sql.unsafe("memory_outbox.space"), sql.unsafe("memory_outbox.memory_id"))} AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) RETURNING id`,
    );
    return rows.length === 1;
  });
  const retryClaimCandidate = Effect.fn("MemoryStore.retryClaimCandidate")(function* (
    id: string,
    nextAttemptAt: number,
    _failure: M.MemoryFailureCode,
    leaseExpiresAt?: number,
  ) {
    yield* stored(
      "claim-retry",
      sql`UPDATE memory_outbox SET status='retry',next_attempt_at=${Math.max(nextAttemptAt, leaseExpiresAt ?? 0)},claimed_by=NULL,claimed_until=NULL WHERE id=${id} AND kind='claim'`,
    );
  });
  const completeClaimCandidate = (id: string) => finishWork(id, "completed");
  const persistResolutionTicket = Effect.fn("MemoryStore.persistResolutionTicket")(function* (
    input: M.MemoryResolutionLease,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const ticket = yield* stored("ticket-codec", decodeTicket(input, strict));
        yield* enqueueWork({
          id: `resolve:${ticket.memorySpaceId}:${ticket.attemptId}`,
          space: ticket.memorySpaceId,
          memoryId: ticket.memoryId,
          kind: "resolve",
          status: "pending",
          metadata: { kind: "resolve", ticket },
          payloadRef: null,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
        const row: TicketRow = {
          ticket,
          version: 0,
          state: "recoverable",
          owner: null,
          coordinatorEpoch: 0,
          ownedUntil: null,
          nextAttemptAt: 0,
          submission: null,
          submissionDigest: null,
          approval: null,
        };
        yield* stored(
          "ticket-initialize",
          sql`UPDATE memory_outbox SET ticket_json=${yield* codec(TicketRowSchema).encode(row)} WHERE id=${`resolve:${ticket.memorySpaceId}:${ticket.attemptId}`} AND ticket_json IS NULL`,
        );
      }),
    );
  });
  return {
    unresolvedSubmission,
    readDueClaimCandidates,
    findClaimCandidate,
    recoverClaimCandidates,
    claimCandidate,
    retryClaimCandidate,
    completeClaimCandidate,
    persistResolutionTicket,
  };
};

export type ClaimCandidates = ReturnType<typeof makeClaimCandidates>;
