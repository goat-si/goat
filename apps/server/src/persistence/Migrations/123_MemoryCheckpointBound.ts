import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { refreshCheckpointAccounting } from "../../memory/MemoryCheckpointAccounting.ts";
import { revisionRecord, type RevisionRow } from "../../memory/MemoryCheckpointInventory.ts";
import { measureForgetReservation } from "../../memory/store/ForgetReservation.ts";
import { lineageForRevision } from "../../memory/store/StoreCodecs.ts";

const decodeLineage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(M.MemoryImportLineageRecord),
);
const decodeSpace = Schema.decodeUnknownEffect(M.MemorySpaceId);
const decodeMemory = Schema.decodeUnknownEffect(M.MemoryId);
const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperationId);
const encodeKeys = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const BATCH_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Re-measures every live identity's forget reservation without the old 64 KiB floor, so
 * refreshed checkpoint counters use the tighter bound in MemoryCheckpointBound.ts. Syncs the
 * hub refused only because the old bound filled checkpoint staging go back to pending with
 * their payload reference restored; forgets keep their own preserved-intent retry.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identities = yield* sql<{
    space: string;
    memory_id: string;
    create_operation_id: string;
    revision_count: number;
    body_bytes: number;
    metadata_bytes: number;
    lineage_bytes: number;
  }>`SELECT i.space,i.memory_id,json_extract(i.identity_json,'$.createOperationId') AS create_operation_id,
      count(r.revision_id) AS revision_count,coalesce(sum(length(CAST(p.body_json AS BLOB))),0) AS body_bytes,
      coalesce(sum(length(CAST(r.parents_json AS BLOB))+length(CAST(r.scope_json AS BLOB))+length(CAST(r.provenance_json AS BLOB))),0) AS metadata_bytes,
      coalesce((SELECT sum(length(CAST(l.record_json AS BLOB))) FROM memory_import_lineage l WHERE l.space=i.space AND l.memory_id=i.memory_id),0) AS lineage_bytes
    FROM memory_identity_ledger i
    LEFT JOIN memory_revisions r ON r.space=i.space AND r.memory_id=i.memory_id
    LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
    WHERE NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)
    GROUP BY i.space,i.memory_id ORDER BY i.space,i.memory_id`;
  for (let offset = 0; offset < identities.length;) {
    const chunk = [];
    let bytes = 0;
    for (const row of identities.slice(offset, offset + 100)) {
      const rowBytes =
        row.body_bytes + row.metadata_bytes + row.lineage_bytes + row.revision_count * 1024;
      if (chunk.length > 0 && bytes + rowBytes > BATCH_MAX_BYTES) break;
      chunk.push(row);
      bytes += rowBytes;
      offset++;
    }
    const keys = encodeKeys(chunk.map((row) => [row.space, row.memory_id]));
    const revisions = yield* sql<
      RevisionRow & { space: string; memory_id: string; body_json: string | null }
    >`
      SELECT r.space,r.memory_id,r.revision_id,r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,r.payload_ref,r.created_at,p.body_json
      FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
      WHERE (r.space,r.memory_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(${keys}))`;
    const lineage = yield* sql<{ space: string; memory_id: string; record_json: string }>`
      SELECT space,memory_id,record_json FROM memory_import_lineage
      WHERE (space,memory_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(${keys}))`;
    const group = <T extends { space: string; memory_id: string }>(rows: readonly T[]) => {
      const grouped = new Map<string, T[]>();
      for (const row of rows) {
        const key = encodeKey([row.space, row.memory_id]);
        const entries = grouped.get(key);
        if (entries) entries.push(row);
        else grouped.set(key, [row]);
      }
      return grouped;
    };
    const revisionsByIdentity = group(revisions);
    const lineageByIdentity = group(lineage);
    for (const row of chunk) {
      const space = yield* decodeSpace(row.space);
      const memoryId = yield* decodeMemory(row.memory_id);
      const key = encodeKey([row.space, row.memory_id]);
      const pairs = yield* Effect.forEach(revisionsByIdentity.get(key) ?? [], (r) =>
        revisionRecord(space, memoryId, r, r.body_json),
      );
      const reservation = yield* measureForgetReservation(
        {
          memorySpaceId: space,
          memoryId,
          operationId: yield* decodeOperation(row.create_operation_id),
        },
        pairs,
        [
          ...(yield* Effect.forEach(lineageByIdentity.get(key) ?? [], (r) =>
            decodeLineage(r.record_json),
          )),
          ...pairs.flatMap(({ revision }) => lineageForRevision(revision)),
        ],
      );
      // Every update, changed or not, marks the identity dirty for the refresh below.
      yield* sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_IDENTITY_CORE_MAX_BYTES + reservation.bytes},reserve_keys=${reservation.keys} WHERE space=${space} AND memory_id=${memoryId}`;
    }
  }
  yield* sql`UPDATE memory_outbox SET status='pending',attempt=0,next_attempt_at=0,claimed_by=NULL,claimed_until=NULL,
      completed_receipt_json=NULL,terminal_at=NULL,hold_class=NULL,failure_code=NULL,sync_version=sync_version+1,
      payload_ref=json_extract(metadata_json,'$.revision.payloadRef')
    WHERE kind='sync' AND status='failed'
      AND json_extract(completed_receipt_json,'$.failureCode')='capacity_exceeded'
      AND json_extract(completed_receipt_json,'$.capacity.dimension')='checkpoint_staging'
      AND json_extract(metadata_json,'$.kind')!='forget'
      AND EXISTS(SELECT 1 FROM memory_payloads p WHERE p.space=memory_outbox.space AND p.payload_ref=json_extract(memory_outbox.metadata_json,'$.revision.payloadRef'))`;
  yield* refreshCheckpointAccounting();
});
