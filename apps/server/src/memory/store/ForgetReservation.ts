import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { exclusionsCodec, lineageCodec, suppressionCodec } from "./StoreCodecs.ts";

/**
 * Bytes and keys a later forget may spend on suppression records: one source exclusion per
 * evidence message of a source-attributed revision, plus each lineage record with the
 * deleteOperationId a suppression adds (64 bytes, as migration 082 charges it).
 */
export const measureForgetReservation = Effect.fnUntraced(function* (
  op: Pick<M.MemoryOperation, "memorySpaceId" | "memoryId" | "operationId">,
  revisions: ReadonlyArray<{ revision: M.MemoryRevision; payload: M.MemoryPayload | null }>,
  lineage: Iterable<M.MemoryImportLineageRecord>,
) {
  const records = new Map<string, M.MemorySuppressionRecord>();
  for (const { revision, payload } of revisions) {
    const { sourceThread, sourceWatermark } = revision.provenance;
    if (!sourceThread || !sourceWatermark) continue;
    for (const messageId of new Set((payload?.evidence ?? []).flatMap((e) => e.messageIds))) {
      const exclusion = { sourceThread, sourceWatermark, messageIds: [messageId] };
      const key = yield* exclusionsCodec.encode([exclusion]);
      records.set(key, {
        memorySpaceId: op.memorySpaceId,
        memoryId: op.memoryId,
        deleteOperationId: op.operationId,
        kind: "sourceExclusion",
        exclusion,
      });
    }
  }
  let bytes = 0;
  for (const record of records.values())
    bytes += new TextEncoder().encode(yield* suppressionCodec.encode(record)).length;
  const unique = new Map<string, M.MemoryImportLineageRecord>();
  for (const record of lineage) unique.set(M.memoryImportLineageRecordKey(record), record);
  for (const record of unique.values())
    bytes += new TextEncoder().encode(yield* lineageCodec.encode(record)).length + 64;
  return { bytes, keys: records.size + unique.size };
});
