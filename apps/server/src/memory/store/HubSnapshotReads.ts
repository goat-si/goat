import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { checkpointCodec, handleCodec, snapshotId, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { strict } from "./StoreModel.ts";

export const makeHubSnapshotReads = (kernel: Pick<StoreKernel, "sql">) => {
  const { sql } = kernel;
  const handlesFor = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "hub-handles-read",
      sql<{
        handles_json: string;
      }>`SELECT handles_json FROM memory_hub_retention WHERE space=${space}`,
    );
    return rows[0] ? yield* handleCodec.decode(rows[0].handles_json, strict) : [];
  });
  const snapshotPages = Effect.fnUntraced(function* (space: M.MemorySpaceId, id: string) {
    const rows = yield* stored(
      "hub-snapshot-pages",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND checkpoint_id=${snapshotId(id)} AND reason='hub_snapshot' ORDER BY page_ordinal`,
    );
    return yield* Effect.forEach(rows, (row) => checkpointCodec.decode(row.metadata_json, strict));
  });
  const snapshotBytes = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "hub-snapshot-bytes",
      sql<{
        bytes: number;
      }>`SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))),0) AS bytes FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot'`,
    );
    return rows[0]!.bytes;
  });
  return {
    handlesFor,
    snapshotPages,
    snapshotBytes,
  };
};

export type HubSnapshotReads = ReturnType<typeof makeHubSnapshotReads>;
