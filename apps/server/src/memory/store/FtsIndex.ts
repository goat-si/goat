import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import { stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryCapacityError } from "./StoreModel.ts";
import type { MemoryIndexTarget } from "./StoreModel.ts";

export const makeFtsIndex = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "readItem" | "readPending">,
) => {
  const { sql, transact } = kernel;
  const { readItem, readPending } = coreReads;
  const index = Effect.fn("MemoryStore.index")(function* (target: MemoryIndexTarget) {
    return yield* transact(
      Effect.gen(function* () {
        const row = yield* readItem(target.memorySpaceId, target.memoryId);
        if (
          !row ||
          row.generation !== target.generation ||
          row.item.status !== "active" ||
          row.item.revision.revisionId !== target.revisionId ||
          row.heads.length !== 1 ||
          (yield* readPending(target.memorySpaceId, target.memoryId))
        )
          return false;
        const brake = yield* stored(
          "fts-brake",
          sql`SELECT 1 FROM memory_fts_maintenance_state WHERE state='braked' LIMIT 1`,
        );
        if (brake.length) return false;
        const bytes = new TextEncoder().encode(row.item.payload.text).length;
        const totals = yield* stored(
          "index-budget",
          sql<{
            bytes: number;
          }>`SELECT coalesce(sum(indexed_bytes),0) AS bytes FROM memory_items WHERE NOT(space=${target.memorySpaceId} AND memory_id=${target.memoryId})`,
        );
        if ((totals[0]?.bytes ?? 0) + bytes > M.MEMORY_FTS_INDEXED_TEXT_MAX_BYTES)
          return yield* new MemoryCapacityError({
            dimension: "ftsIndexedTextBytes",
            limit: M.MEMORY_FTS_INDEXED_TEXT_MAX_BYTES,
          });
        yield* stored(
          "fts-delete",
          sql`DELETE FROM memory_items_fts WHERE rowid IN (SELECT rowid FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId})`,
        );
        yield* stored(
          "fts-insert",
          sql`INSERT INTO memory_items_fts (rowid,body) SELECT rowid,${row.item.payload.text} FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        yield* stored(
          "fts-fence",
          sql`UPDATE memory_items SET index_state='ready',indexed_revision=${target.revisionId},indexed_generation=${target.generation},indexed_bytes=${bytes} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        yield* stored(
          "fts-count",
          sql`UPDATE memory_fts_maintenance_state SET changed_rows=changed_rows+1`,
        );
        return true;
      }),
    );
  });
  return {
    index,
  };
};

export type FtsIndex = ReturnType<typeof makeFtsIndex>;
