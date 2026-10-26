import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import { ftsMatchQuery } from "./SearchText.ts";
import { decodeMemoryId, decodeScope, encodeSearchItem, scopeKey, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryCapacityError, MemoryStoreConflict, strict } from "./StoreModel.ts";
import type { MemoryReadFilter } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

export const makeSearch = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "readItem">,
) => {
  const { sql, transact } = kernel;
  const { readItem } = coreReads;
  const readCursor = Effect.fnUntraced(function* (space: M.MemorySpaceId, hub: M.EnvironmentId) {
    const rows = yield* stored(
      "cursor",
      sql<{
        after_sequence: number;
      }>`SELECT after_sequence FROM memory_sync_cursors WHERE space=${space} AND hub_environment_id=${hub}`,
    );
    return rows[0]?.after_sequence ?? 0;
  });
  const withReceivedCursor: MemoryStoreShape["withReceivedCursor"] = (input, effect) =>
    transact(
      Effect.gen(function* () {
        const current = yield* readCursor(input.memorySpaceId, input.hubEnvironmentId);
        if (current !== input.expectedSequence || input.afterSequence < current)
          return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
        const result = yield* effect;
        yield* stored(
          "cursor-write",
          sql`INSERT INTO memory_sync_cursors (space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${input.memorySpaceId},${input.hubEnvironmentId},${input.afterSequence},'ready') ON CONFLICT(space,hub_environment_id) DO UPDATE SET after_sequence=excluded.after_sequence`,
        );
        return result;
      }),
    );
  const list = Effect.fn("MemoryStore.list")(function* (filter: MemoryReadFilter) {
    if (
      !Number.isInteger(filter.limit) ||
      filter.limit < 1 ||
      filter.limit > M.MEMORY_PAGE_MAX_ITEMS
    )
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    const scope = yield* stored("scope-codec", decodeScope(filter.scope, strict));
    const rows = yield* stored(
      "list",
      sql<{
        memory_id: string;
      }>`SELECT memory_id FROM memory_items WHERE space=${filter.memorySpaceId} AND scope_key=${scopeKey(scope)} AND memory_id>${filter.afterMemoryId ?? ""} ORDER BY memory_id LIMIT ${filter.limit}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const id = yield* stored("item-id", decodeMemoryId(row.memory_id));
        return (yield* readItem(filter.memorySpaceId, id))!.item;
      }),
    );
  });
  // A request advances at most one durable batch; mutations of counted rows adjust totals in SQL.
  const searchCoverage = Effect.fn("MemoryStore.searchCoverage")(function* (
    filter: MemoryReadFilter,
  ) {
    const state = (yield* stored(
      "search-backfill-state",
      sql<{
        after_rowid: number;
        ready: number;
      }>`SELECT after_rowid,ready FROM memory_search_backfill WHERE singleton=1`,
    ))[0]!;
    let ready = state.ready === 1;
    if (!ready) {
      const rows = yield* stored(
        "search-backfill-window",
        sql<{
          rowid: number;
        }>`SELECT rowid FROM memory_items WHERE rowid>${state.after_rowid} ORDER BY rowid LIMIT 1000`,
      );
      for (const row of rows)
        yield* stored(
          "search-backfill-row",
          sql`UPDATE memory_items SET search_counted=1,search_text_bytes=coalesce((SELECT length(CAST(json_extract(body_json,'$.text') AS BLOB)) FROM memory_payloads p WHERE p.space=memory_items.space AND p.payload_ref=memory_items.payload_ref),0) WHERE rowid=${row.rowid} AND search_counted=0`,
        );
      ready = rows.length < 1000;
      yield* stored(
        "search-backfill-progress",
        sql`UPDATE memory_search_backfill SET after_rowid=${rows.at(-1)?.rowid ?? state.after_rowid},ready=${ready ? 1 : 0} WHERE singleton=1`,
      );
    }
    const rows = yield* stored(
      "search-coverage",
      sql<{
        eligible: number;
        indexed: number;
        text_bytes: number;
      }>`SELECT eligible,indexed,text_bytes FROM memory_search_counters WHERE space=${filter.memorySpaceId} AND scope_key=${scopeKey(filter.scope)}`,
    );
    return {
      ready,
      eligible: rows[0]?.eligible ?? 0,
      indexed: rows[0]?.indexed ?? 0,
      textBytes: rows[0]?.text_bytes ?? 0,
    };
  });
  const search = Effect.fn("MemoryStore.search")(function* (
    filter: MemoryReadFilter,
    text: string,
    mode: "fts" | "substring",
  ) {
    if (
      !Number.isInteger(filter.limit) ||
      filter.limit < 1 ||
      filter.limit > M.MEMORY_PAGE_MAX_ITEMS
    )
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    const key = scopeKey(yield* stored("scope-codec", decodeScope(filter.scope, strict)));
    const coverage = yield* searchCoverage(filter);
    if (!coverage.ready) {
      if (mode === "substring") return yield* new MemoryStoreConflict({ code: "unavailable" });
      return { items: [], examinedAfterMemoryId: filter.afterMemoryId ?? null, exhausted: false };
    }
    if (
      mode === "substring" &&
      (coverage.eligible > M.MEMORY_SUBSTRING_MAX_ITEMS ||
        coverage.textBytes > M.MEMORY_SUBSTRING_MAX_UTF8_BYTES)
    )
      return yield* new MemoryCapacityError({
        dimension: "substring",
        limit: M.MEMORY_SUBSTRING_MAX_ITEMS,
      });
    // MATERIALIZED prevents MATCH/instr from being flattened ahead of the indexed keyset LIMIT.
    // Correlated rowid MATCH visits only the selected FTS row, including for absent terms.
    const rows =
      mode === "fts"
        ? yield* stored(
            "fts-search",
            sql<{ memory_id: string; matches: number }>`WITH window AS MATERIALIZED (
        SELECT rowid,memory_id,status,index_state,indexed_generation,generation FROM memory_items
        WHERE space=${filter.memorySpaceId} AND scope_key=${key} AND memory_id>${filter.afterMemoryId ?? ""} ORDER BY memory_id LIMIT 1000
      ) SELECT memory_id,CASE WHEN status='active' AND index_state='ready' AND indexed_generation=generation THEN EXISTS(SELECT 1 FROM memory_items_fts WHERE rowid=window.rowid AND memory_items_fts MATCH ${ftsMatchQuery(text)}) ELSE 0 END AS matches FROM window ORDER BY memory_id`,
          )
        : yield* stored(
            "substring-search",
            sql<{ memory_id: string; matches: number }>`WITH window AS MATERIALIZED (
        SELECT memory_id,status,payload_ref FROM memory_items WHERE space=${filter.memorySpaceId} AND scope_key=${key} AND memory_id>${filter.afterMemoryId ?? ""} ORDER BY memory_id LIMIT 1000
      ) SELECT memory_id,CASE WHEN status='active' THEN coalesce((SELECT instr(json_extract(body_json,'$.text'),${text})>0 FROM memory_payloads WHERE space=${filter.memorySpaceId} AND payload_ref=window.payload_ref),0) ELSE 0 END AS matches FROM window ORDER BY memory_id`,
          );
    const items: M.MemoryItem[] = [];
    let examinedAfterMemoryId = filter.afterMemoryId ?? null;
    let bytes = 2048; // Reserve the bounded server cursor, watermark and coverage envelope.
    for (const row of rows) {
      const id = yield* stored("item-id", decodeMemoryId(row.memory_id));
      if (row.matches) {
        const item = (yield* readItem(filter.memorySpaceId, id))!.item;
        const size =
          new TextEncoder().encode(yield* stored("search-item-codec", encodeSearchItem(item)))
            .length + 1;
        if (bytes + size > M.MEMORY_PAGE_MAX_UTF8_BYTES) {
          if (!items.length) return yield* new MemoryStoreConflict({ code: "payload_too_large" });
          return { items, examinedAfterMemoryId, exhausted: false };
        }
        items.push(item);
        bytes += size;
      }
      examinedAfterMemoryId = id;
      if (items.length === filter.limit) return { items, examinedAfterMemoryId, exhausted: false };
    }
    return { items, examinedAfterMemoryId, exhausted: rows.length < 1000 };
  });
  return {
    readCursor,
    withReceivedCursor,
    list,
    searchCoverage,
    search,
  };
};

export type Search = ReturnType<typeof makeSearch>;
