import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { recordCanonicalMemoryOrigin } from "../MemoryRevisionMarks.ts";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStoreConflict, Transaction } from "./StoreModel.ts";

const encoder = new TextEncoder();
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeOriginCatchup = ({
  sql,
  emit,
  nextWatermark,
}: Pick<StoreKernel, "sql" | "emit" | "nextWatermark">) => {
  const readOriginCursor = Effect.fn("MemoryStore.readOriginCursor")(function* (
    space: M.MemorySpaceId,
    hub: M.EnvironmentId,
  ) {
    const [row] = yield* stored(
      "memory-origin-cursor",
      sql<{ after_origin_sequence: number }>`
      SELECT after_origin_sequence FROM memory_sync_cursors WHERE space=${space} AND hub_environment_id=${hub}`,
    );
    return row?.after_origin_sequence ?? 0;
  });
  const readOriginPageTx = Effect.fn("MemoryStore.readOriginPageTx")(function* (
    space: M.MemorySpaceId,
    after: number,
  ) {
    yield* Transaction;
    const rows = yield* stored(
      "memory-origin-page",
      sql<M.MemoryOriginPage["updates"][number]>`SELECT o.origin_sequence AS sequence,
        o.memory_id AS memoryId,
        json_extract(i.identity_json,'$.origin.environmentId') AS environmentId,
        json_extract(i.identity_json,'$.origin.threadId') AS threadId,
        json_extract(i.identity_json,'$.createOperationId') AS createOperationId
      FROM memory_origins o JOIN memory_identity_ledger i ON i.space=o.space AND i.memory_id=o.memory_id
      WHERE o.space=${space} AND o.origin_sequence>0 AND o.origin_sequence>${after}
        AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=o.space AND t.memory_id=o.memory_id)
        AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.memory_id=o.memory_id)
      ORDER BY o.origin_sequence LIMIT ${M.MEMORY_ORIGIN_UPDATE_MAX + 1}`,
    );
    let bytes = 0;
    const updates: M.MemoryOriginPage["updates"][number][] = [];
    for (const row of rows.slice(0, M.MEMORY_ORIGIN_UPDATE_MAX)) {
      bytes += encoder.encode(yield* stored("memory-origin-encode", encodeJson(row))).length + 1;
      if (bytes > M.MEMORY_PAGE_MAX_UTF8_BYTES - 512) break;
      updates.push(row);
    }
    if (rows.length && !updates.length)
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    return {
      updates,
      throughSequence: updates.at(-1)?.sequence ?? after,
      hasMore: rows.length > updates.length,
    };
  });
  const receiveOriginPageTx = Effect.fn("MemoryStore.receiveOriginPageTx")(function* (
    space: M.MemorySpaceId,
    hub: M.EnvironmentId,
    after: number,
    { updates, throughSequence, hasMore }: M.MemoryOriginPage,
  ) {
    yield* Transaction;
    const current = yield* readOriginCursor(space, hub);
    if (throughSequence <= current && !hasMore) return;
    let previous = after;
    for (const update of updates) {
      if (update.sequence <= previous || update.sequence > throughSequence)
        return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
      previous = update.sequence;
    }
    if (after !== current || previous !== throughSequence || (hasMore && !updates.length))
      return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
    let changed = false;
    for (const { memoryId, createOperationId, environmentId, threadId } of updates) {
      const recorded = yield* recordCanonicalMemoryOrigin(
        space,
        memoryId,
        { environmentId, threadId },
        createOperationId,
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      changed ||= recorded;
    }
    yield* stored(
      "memory-origin-advance",
      sql`UPDATE memory_sync_cursors SET after_origin_sequence=${throughSequence}
        WHERE space=${space} AND hub_environment_id=${hub} AND bootstrap_state='ready'`,
    );
    if (changed)
      yield* emit({
        kind: "reset",
        memorySpaceId: space,
        projectionWatermark: yield* nextWatermark(space),
      });
  });
  return { readOriginCursor, readOriginPageTx, receiveOriginPageTx };
};

export type OriginCatchup = ReturnType<typeof makeOriginCatchup>;
