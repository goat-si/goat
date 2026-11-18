import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { DeferredRow } from "../store/StoreModel.ts";
import { MEMORY_SCANNER_POLICY_VERSION, scanMemoryValue } from "../MemorySecretScanner.ts";
import * as Store from "../MemoryStore.ts";

const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(DeferredRow));

export const scanReplicaMemory = Effect.fn("test.scanReplicaMemory")(function* (
  memoryId: M.MemoryId,
) {
  const store = yield* Store.MemoryStore;
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ space: string; deferred_json: string }>`
    SELECT i.space,d.value AS deferred_json FROM memory_items i,json_each(i.deferred_json) d
    WHERE i.memory_id=${memoryId} AND json_extract(d.value,'$.kind')='scanner'
      AND json_extract(d.value,'$.state')='pending' LIMIT 1`;
  if (!row) throw new Error("Expected received scanner work");
  const work = {
    ...(yield* decodeRow(row.deferred_json)),
    memoryId,
    memorySpaceId: M.MemorySpaceId.make(row.space),
    payloadBytes: 0,
  };
  const chunk = yield* store.readScannerChunk(work);
  if (chunk.nextCursor !== null || scanMemoryValue({ payloads: chunk.payloads }).kind !== "allowed")
    throw new Error("Expected one clean synthetic scanner page");
  if (
    !(yield* store.finishDeferred(work, {
      now,
      scannerPolicyVersion: MEMORY_SCANNER_POLICY_VERSION,
    }))
  )
    throw new Error("Expected scanner work to settle");
});
