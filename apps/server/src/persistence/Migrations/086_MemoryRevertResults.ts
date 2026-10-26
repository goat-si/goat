import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { MemoryRevertSlot, revertSlotFromReceipt } from "../../memory/MemoryRevertSlot.ts";

const compact = Schema.decodeUnknownEffect(Schema.fromJsonString(M.MemoryCompactReceipt));
const encodeSlot = Schema.encodeEffect(Schema.fromJsonString(MemoryRevertSlot));
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const receipt = Schema.decodeUnknownEffect(Schema.fromJsonString(M.MemoryHubReceipt));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_resolutions ADD COLUMN revert_result_json TEXT
    CHECK(revert_result_json IS NULL OR (json_valid(revert_result_json) AND length(CAST(revert_result_json AS BLOB))<=2048))`;
  // Delivered reports have time retention, not a cardinality cap. This is a narrow
  // existing-table history index, not a corpus/search index. rowid supplies the cursor.
  yield* sql`CREATE INDEX memory_report_memory_idx ON memory_report_outbox(space,memory_id)`;

  // 078 usage_* excludes resolution metadata, but 076's local input meter
  // retains 072's serialized resolution charge. Extend that meter, including the
  // previously unused operation-id column. Slot data is not a checkpoint record.
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT space,'memory_input_bytes','',coalesce(sum(length(CAST(revert_operation_id AS BLOB))),0)
    FROM memory_resolutions GROUP BY space
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`;
  const bytes = (p: string) =>
    `coalesce(length(CAST(${p}.revert_result_json AS BLOB)),0)+coalesce(length(CAST(${p}.revert_operation_id AS BLOB)),0)`;
  const delta = (p: string, sign: number) =>
    sign < 0
      ? `UPDATE memory_quota_counters SET value=value-(${bytes(p)}) WHERE space=${p}.space AND dimension='memory_input_bytes' AND scope_key='';`
      : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${p}.space,'memory_input_bytes','',${bytes(p)}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const)
    yield* sql.unsafe(
      `CREATE TRIGGER memory_revert_result_input_${action.toLowerCase()} AFTER ${action} ON memory_resolutions BEGIN ${action !== "INSERT" ? delta("OLD", -1) : ""}${action !== "DELETE" ? delta("NEW", 1) : ""} END`,
    );

  // Backfill only unambiguous correlation. Conflicting attempts without comparable
  // creation evidence stay unknown; an authoritative acceptance takes precedence.
  const candidates = yield* sql<{
    space: string;
    memory_id: string;
    resolution_id: string;
    operation_id: string;
    revision_id: string | null;
    result: string | null;
    pending: number;
  }>`SELECT space,memory_id,resolution_id,operation_id,NULL AS revision_id,NULL AS result,1 AS pending FROM memory_revert_intents
    UNION ALL SELECT space,memory_id,json_extract(metadata_json,'$.revertsResolutionId'),json_extract(metadata_json,'$.operationId'),json_extract(metadata_json,'$.revision.revisionId'),completed_receipt_json,0
    FROM memory_outbox WHERE kind='revert_intent' AND completed_receipt_json IS NOT NULL`;
  const known = new Map<
    string,
    { row: (typeof candidates)[number]; slot: ReturnType<typeof revertSlotFromReceipt> }[]
  >();
  for (const row of candidates) {
    const result = row.result
      ? yield* receipt(row.result).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
    if (result && (result.operationId !== row.operation_id || result.memoryId !== row.memory_id))
      continue;
    const slot = result
      ? revertSlotFromReceipt(result, row.revision_id as M.MemoryRevisionId | null)
      : row.pending
        ? { status: "pending" as const }
        : undefined;
    if (!slot || !row.resolution_id) continue;
    const key = encodeKey([row.space, row.memory_id, row.resolution_id]);
    known.set(key, [...(known.get(key) ?? []), { row, slot }]);
  }
  const receipts = yield* sql<{
    compact_json: string;
  }>`SELECT compact_json FROM memory_compact_receipts WHERE json_extract(compact_json,'$.operationKind')='revert'`;
  for (const row of receipts) {
    const record = yield* compact(row.compact_json).pipe(Effect.orElseSucceed(() => undefined));
    if (!record?.revertsResolutionId) continue;
    const slot = revertSlotFromReceipt(record.receipt, record.revisionId);
    if (!slot) continue;
    const candidate = {
      space: record.memorySpaceId,
      memory_id: record.receipt.memoryId,
      resolution_id: record.revertsResolutionId,
      operation_id: record.receipt.operationId,
      revision_id: record.revisionId,
      result: null,
      pending: 0,
    };
    const key = encodeKey([candidate.space, candidate.memory_id, candidate.resolution_id]);
    known.set(key, [...(known.get(key) ?? []), { row: candidate, slot }]);
  }
  for (const attempts of known.values()) {
    const accepted = attempts.filter((a) => a.slot?.status === "accepted");
    const eligible = accepted.length ? accepted : attempts;
    if (new Set(eligible.map((a) => a.row.operation_id)).size !== 1) continue;
    const selected = eligible.find((a) => a.slot?.status !== "pending") ?? eligible[0]!;
    const r = selected.row;
    yield* sql`UPDATE memory_resolutions SET revert_operation_id=${r.operation_id},revert_result_json=${yield* encodeSlot(selected.slot!)}
      WHERE space=${r.space} AND memory_id=${r.memory_id} AND resolution_id=${r.resolution_id}`;
  }
  // Delete knowledge is authoritative for pending attempts, never for acceptance.
  yield* sql`UPDATE memory_resolutions SET revert_result_json='{"status":"forgotten"}'
    WHERE json_extract(revert_result_json,'$.status')='pending' AND
    (EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=memory_resolutions.space AND t.memory_id=memory_resolutions.memory_id)
    OR EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_resolutions.space AND f.memory_id=memory_resolutions.memory_id))`;
});
