import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { availabilityCodec, localMetadataCodec, projectionCodec, stored } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStoreConflict, strict } from "./StoreModel.ts";

export const makeCompaction = (kernel: Pick<StoreKernel, "sql" | "transact">) => {
  const { sql, transact } = kernel;
  const prunePayloads = Effect.fn("MemoryStore.prunePayloads")(function* (
    now: number,
    limit: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "payload-retention",
          sql<{
            space: string;
            payload_ref: string;
          }>`SELECT p.space,p.payload_ref FROM memory_payloads p
        WHERE p.purge_eligible_after IS NOT NULL AND p.purge_eligible_after<=${now} AND (p.revert_deadline IS NULL OR p.revert_deadline<=${now})
        AND EXISTS (SELECT 1 FROM memory_compaction_state c WHERE c.space=p.space AND c.published=1)
        AND NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE i.space=p.space AND v.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_conflicts c JOIN json_each(c.heads_json) h JOIN memory_revisions v ON v.space=c.space AND v.revision_id=h.value WHERE c.space=p.space AND c.status!='resolved' AND v.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=p.space AND o.payload_ref=p.payload_ref AND o.status IN ('pending','retry','running'))
        AND NOT EXISTS (SELECT 1 FROM memory_revert_intents r WHERE r.space=p.space AND r.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_resolutions r JOIN json_each(r.input_payload_refs_json) refs WHERE r.space=p.space AND refs.value=p.payload_ref AND r.revert_deadline>${now})
        AND (EXISTS (SELECT 1 FROM memory_revisions r JOIN memory_events e ON e.memory_space_id=r.space AND e.operation_id=r.operation_id WHERE r.space=p.space AND r.payload_ref=p.payload_ref AND json_extract(e.receipt_json,'$.hubSequence') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM memory_resolutions r
          JOIN memory_compact_receipts k ON k.space=r.space AND json_extract(k.compact_json,'$.operationKind')='resolve'
            AND json_extract(k.compact_json,'$.resolutionId')=r.resolution_id AND json_extract(k.compact_json,'$.revisionId')=r.result_revision_id
            AND json_extract(k.compact_json,'$.receipt.memoryId')=r.memory_id
          JOIN memory_compaction_state c ON c.space=r.space AND c.published=1
          LEFT JOIN memory_revisions v ON v.space=r.space AND v.revision_id=r.result_revision_id
          WHERE r.space=p.space AND r.judgment_payload_ref=p.payload_ref AND r.revert_deadline<=${now}
          AND json_extract(k.receipt_json,'$.outcome')='accepted'
          AND k.hub_sequence<=json_extract(c.boundary_json,'$.checkpointSequence')
          AND NOT EXISTS (SELECT 1 FROM memory_revert_intents ri WHERE ri.space=r.space AND ri.resolution_id=r.resolution_id)
          AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=r.space AND o.status IN ('pending','retry','running') AND (o.payload_ref=v.payload_ref OR instr(o.metadata_json,r.result_revision_id)>0 OR instr(o.metadata_json,r.resolution_id)>0 OR instr(coalesce(o.ticket_json,''),r.result_revision_id)>0 OR instr(coalesce(o.ticket_json,''),r.resolution_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.result_revision_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.resolution_id)>0))
          AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending b JOIN memory_hub_retention h ON h.space=b.space WHERE b.space=r.space AND (b.payload_ref=p.payload_ref OR b.reason='hub_snapshot' AND (b.checkpoint_id='hub:'||h.checkpoint_id OR EXISTS(SELECT 1 FROM json_each(h.handles_json) t WHERE 'hub:'||json_extract(t.value,'$.checkpointId')=b.checkpoint_id AND json_extract(t.value,'$.expiresAt')>${now})) AND EXISTS(SELECT 1 FROM json_each(b.metadata_json,'$.resolutions') j WHERE json_extract(j.value,'$.resolution.resolutionId')=r.resolution_id)))))
        ORDER BY p.purge_eligible_after,p.space,p.payload_ref LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
        );
        for (const row of rows)
          yield* stored(
            "payload-retention-purge",
            sql`DELETE FROM memory_payloads WHERE space=${row.space} AND payload_ref=${row.payload_ref}`,
          );
        return rows.length;
      }),
    );
  });
  const forgetLocalIntent = Effect.fn("MemoryStore.forgetLocalIntent")(function* (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const id = `local:${environmentId}:${intentId}`;
        const rows = yield* stored(
          "local-forget",
          sql<{ metadata_json: string }>`SELECT metadata_json FROM memory_outbox WHERE id=${id}`,
        );
        if (!rows[0]) return;
        const draft = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
        if (draft.mapping) return yield* new MemoryStoreConflict({ code: "space_mismatch" });
        yield* stored(
          "local-forget-purge",
          sql`DELETE FROM memory_payloads WHERE space=${`_local:${environmentId}`} AND payload_ref=${intentId}`,
        );
        yield* stored(
          "local-forget-fence",
          sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL WHERE id=${id}`,
        );
      }),
    );
  });
  const cleanupDerived = Effect.fn("MemoryStore.cleanupDerived")(function* (limit: number) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "cleanup-targets",
          sql<{
            space: string;
            memory_id: string;
            rowid: number;
            generation: number;
            item_json: string;
          }>`SELECT * FROM memory_items WHERE cleanup_pending=1 ORDER BY projection_watermark,memory_id LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
        );
        let count = 0;
        for (const row of rows) {
          const success = yield* sql`DELETE FROM memory_items_fts WHERE rowid=${row.rowid}`.pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!success) continue;
          const projection = yield* projectionCodec.decode(row.item_json, strict);
          const availability = { ...projection.localAvailability, cleanupPending: false };
          yield* stored(
            "cleanup-settle",
            sql`UPDATE memory_items SET cleanup_pending=0,indexed_bytes=0,indexed_revision=NULL,indexed_generation=NULL,item_json=${yield* projectionCodec.encode({ ...projection, localAvailability: availability })},availability_json=${yield* availabilityCodec.encode(availability)} WHERE space=${row.space} AND memory_id=${row.memory_id} AND generation=${row.generation}`,
          );
          count++;
        }
        return count;
      }),
    );
  });
  return {
    prunePayloads,
    forgetLocalIntent,
    cleanupDerived,
  };
};

export type Compaction = ReturnType<typeof makeCompaction>;
