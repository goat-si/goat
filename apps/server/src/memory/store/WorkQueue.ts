import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ItemWrites } from "./ItemWrites.ts";
import {
  receiptCodec,
  stored,
  storedTicketRowCodec,
  threadCodec,
  threadHookCodec,
  workMetadataCodec,
  workRows,
} from "./StoreCodecs.ts";
import type { WorkRow } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStoreConflict, MemoryWork, strict, threadHookId } from "./StoreModel.ts";

export const makeWorkQueue = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  itemWrites: Pick<ItemWrites, "enqueueWork">,
) => {
  const { sql, transact } = kernel;
  const { enqueueWork } = itemWrites;
  const readWork = Effect.fn("MemoryStore.readWork")(function* (id: string) {
    const rows = yield* stored(
      "read-work",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE id=${id} AND admin_json IS NULL`,
    );
    return (yield* workRows(rows))[0];
  });
  const retryWork = Effect.fn("MemoryStore.retryWork")(function* (
    work: MemoryWork,
    nextAttemptAt: number,
  ) {
    if (work.status !== "running" || work.claimedBy === null || work.claimedUntil === null)
      return false;
    const rows = yield* stored(
      "retry-work",
      sql`UPDATE memory_outbox SET status='retry',next_attempt_at=${nextAttemptAt},claimed_by=NULL,claimed_until=NULL WHERE id=${work.id} AND kind NOT IN ('claim','resolve','revert_intent') AND status='running' AND claimed_by=${work.claimedBy} AND claimed_until=${work.claimedUntil} AND attempt=${work.attempt} RETURNING id`,
    );
    return rows.length === 1;
  });
  const rearmGenerationWork = Effect.fn("MemoryStore.rearmGenerationWork")(function* (now: number) {
    const rows = yield* stored(
      "rearm-generation-work",
      sql`UPDATE memory_outbox SET next_attempt_at=${now} WHERE kind IN ('summary','consolidate') AND status='retry' AND next_attempt_at>${now} RETURNING id`,
    );
    return rows.length;
  });
  const renewWork = Effect.fn("MemoryStore.renewWork")(function* (
    work: MemoryWork,
    now: number,
    until: number,
  ) {
    if (work.status !== "running" || work.claimedBy === null || work.claimedUntil === null)
      return undefined;
    const rows = yield* stored(
      "renew-work",
      sql`UPDATE memory_outbox SET claimed_until=${until} WHERE id=${work.id} AND kind IN ('summary','consolidate','rebuild') AND status='running' AND claimed_by=${work.claimedBy} AND claimed_until=${work.claimedUntil} AND attempt=${work.attempt} AND claimed_until>${now} RETURNING id`,
    );
    return rows.length === 1 ? { ...work, claimedUntil: until } : undefined;
  });
  const rebindWorkModel = Effect.fn("MemoryStore.rebindWorkModel")(function* (
    work: MemoryWork,
    modelSelection: M.MemoryModelSelection,
  ) {
    if (
      work.metadata.kind !== "summary" ||
      work.status !== "running" ||
      work.claimedBy === null ||
      work.claimedUntil === null
    )
      return undefined;
    const metadata = { ...work.metadata, modelSelection };
    const rows = yield* stored(
      "rebind-work-model",
      sql`UPDATE memory_outbox SET metadata_json=${yield* workMetadataCodec.encode(metadata)} WHERE id=${work.id} AND kind IN ('summary','consolidate') AND status='running' AND claimed_by=${work.claimedBy} AND claimed_until=${work.claimedUntil} AND attempt=${work.attempt} RETURNING id`,
    );
    return rows.length === 1 ? { ...work, metadata } : undefined;
  });
  const cancelThreadWork = Effect.fn("MemoryStore.cancelThreadWork")(function* (
    input: M.ScopedThreadRef,
  ) {
    const thread = yield* threadCodec.decode(yield* threadCodec.encode(input), strict);
    const rows = yield* stored(
      "cancel-thread-work",
      sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL,claimed_by=NULL,claimed_until=NULL WHERE kind IN ('summary','consolidate') AND status IN ('pending','running','retry') AND json_extract(metadata_json,'$.kind')='summary' AND json_extract(metadata_json,'$.sourceThread.environmentId')=${thread.environmentId} AND json_extract(metadata_json,'$.sourceThread.threadId')=${thread.threadId} RETURNING id`,
    );
    return rows.length;
  });
  const readThreadHookWatermark = Effect.fn("MemoryStore.readThreadHookWatermark")(function* () {
    const rows = yield* stored(
      "thread-hook-read",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_outbox WHERE id=${threadHookId}`,
    );
    return rows[0] ? (yield* threadHookCodec.decode(rows[0].metadata_json, strict)).watermark : 0;
  });
  const commitThreadHook = Effect.fn("MemoryStore.commitThreadHook")(function* (input: {
    expectedWatermark: number;
    throughWatermark: number;
    work: ReadonlyArray<MemoryWork>;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const metadata = yield* threadHookCodec.encode({
          kind: "threadHook",
          watermark: input.throughWatermark,
        });
        if (
          input.throughWatermark < input.expectedWatermark ||
          (yield* readThreadHookWatermark()) !== input.expectedWatermark
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        if (input.work.some((work) => work.id === threadHookId))
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        for (const work of input.work) yield* enqueueWork(work);
        // Completed marker is never runnable; no transcript is retained in hook metadata.
        yield* stored(
          "thread-hook-commit",
          sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES (${threadHookId},'_worker','rebuild','completed',${metadata},0) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json`,
        );
      }),
    );
  });
  const dueWork = Effect.fn("MemoryStore.dueWork")(function* (
    now: number,
    limit: number,
    kinds: ReadonlyArray<"summary" | "consolidate" | "rebuild"> = [
      "summary",
      "consolidate",
      "rebuild",
    ],
  ) {
    // Filter before the limit so skipped kinds cannot fill every page.
    if (!kinds.length) return [];
    const rows = yield* stored(
      "due-work",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE kind IN ${sql.in(kinds)} AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${now})) AND next_attempt_at<=${now} ORDER BY next_attempt_at,attempt,id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
    return yield* workRows(rows);
  });
  const claimWork = Effect.fn("MemoryStore.claimWork")(function* (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) {
    const rows = yield* stored(
      "claim-work",
      sql`UPDATE memory_outbox SET status='running',claimed_by=${owner},claimed_until=${until},attempt=min(attempt+1,2147483647) WHERE id=${id} AND kind NOT IN ('claim','resolve','revert_intent') AND next_attempt_at<=${now} AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${now})) RETURNING id`,
    );
    return rows.length === 1;
  });
  const clearTerminalSubmission = Effect.fnUntraced(function* (id: string) {
    const rows = yield* stored(
      "terminal-submission",
      sql<{
        space: string;
        ticket_json: string;
      }>`SELECT space,ticket_json FROM memory_outbox WHERE id=${id} AND kind='resolve' AND ticket_json IS NOT NULL`,
    );
    if (!rows[0]) return;
    const row = yield* stored(
      "terminal-ticket",
      storedTicketRowCodec.decode(rows[0].ticket_json, strict),
    );
    yield* stored(
      "terminal-submission-purge",
      sql`DELETE FROM memory_payloads WHERE space=${rows[0].space} AND payload_ref=${`submission:${row.ticket.attemptId}`}`,
    );
    yield* stored(
      "terminal-ticket-fence",
      sql`UPDATE memory_outbox SET ticket_json=${yield* storedTicketRowCodec.encode({ ...row, state: "terminal", version: row.version + 1, submission: null, submissionDigest: null, owner: null, ownedUntil: null })},sync_version=sync_version+1,payload_ref=NULL WHERE id=${id}`,
    );
  });
  const finishWork = Effect.fn("MemoryStore.finishWork")(function* (
    id: string,
    status: "completed" | "cancelled" | "failed",
    result?: M.MemoryHubReceipt,
  ) {
    yield* transact(
      Effect.gen(function* () {
        yield* clearTerminalSubmission(id);
        yield* stored(
          "finish-work",
          sql`UPDATE memory_outbox SET status=${status},terminal_at=${yield* Clock.currentTimeMillis},claimed_by=NULL,claimed_until=NULL,completed_receipt_json=${result ? yield* receiptCodec.encode(result) : null},payload_ref=NULL WHERE id=${id}`,
        );
      }),
    );
  });
  return {
    readWork,
    retryWork,
    rearmGenerationWork,
    renewWork,
    rebindWorkModel,
    cancelThreadWork,
    readThreadHookWatermark,
    commitThreadHook,
    dueWork,
    claimWork,
    clearTerminalSubmission,
    finishWork,
  };
};

export type WorkQueue = ReturnType<typeof makeWorkQueue>;
