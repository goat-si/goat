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
  }>`SELECT space,memory_id,json_extract(identity_json,'$.createOperationId') AS create_operation_id FROM memory_identity_ledger i
    WHERE NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)`;
  for (const row of identities) {
    const space = yield* decodeSpace(row.space);
    const memoryId = yield* decodeMemory(row.memory_id);
    const revisions = yield* sql<RevisionRow & { body_json: string | null }>`
      SELECT r.revision_id,r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,r.payload_ref,r.created_at,p.body_json
      FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
      WHERE r.space=${space} AND r.memory_id=${memoryId}`;
    const pairs = yield* Effect.forEach(revisions, (r) =>
      revisionRecord(space, memoryId, r, r.body_json),
    );
    const lineage = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM memory_import_lineage WHERE space=${space} AND memory_id=${memoryId}`;
    const reservation = yield* measureForgetReservation(
      {
        memorySpaceId: space,
        memoryId,
        operationId: yield* decodeOperation(row.create_operation_id),
      },
      pairs,
      [
        ...(yield* Effect.forEach(lineage, (r) => decodeLineage(r.record_json))),
        ...pairs.flatMap(({ revision }) => lineageForRevision(revision)),
      ],
    );
    // Every update, changed or not, marks the identity dirty for the refresh below.
    yield* sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_IDENTITY_CORE_MAX_BYTES + reservation.bytes},reserve_keys=${reservation.keys} WHERE space=${space} AND memory_id=${memoryId}`;
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
