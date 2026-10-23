import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import {
  decodeLocalIntent,
  decodeOperation,
  headsCodec,
  localMetadataCodec,
  payloadCodec,
  stored,
  threadCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  LocalMemoryIntent,
  MemoryStoreConflict,
  Transaction,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { IntentIdentityInput } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

export const makeLocalIntents = (
  kernel: Pick<StoreKernel, "sql" | "transact">,
  coreReads: Pick<CoreReads, "receipt">,
) => {
  const { sql, transact } = kernel;
  const { receipt } = coreReads;
  const putLocalIntent = Effect.fn("MemoryStore.putLocalIntent")(function* (
    input: LocalMemoryIntent,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("local-intent-codec", decodeLocalIntent(input, strict));
        const space = `_local:${intent.environmentId}`;
        const old = yield* stored(
          "local-intent",
          sql<{
            metadata_json: string;
          }>`SELECT metadata_json FROM memory_outbox WHERE id=${`local:${intent.environmentId}:${intent.intentId}`}`,
        );
        const json = yield* localMetadataCodec.encode({
          kind: "localIntent",
          intentId: intent.intentId,
          environmentId: intent.environmentId,
          memoryId: intent.memoryId,
          scope: intent.scope,
          provenance: intent.provenance,
          assertionKind: intent.assertionKind,
          createdAtUtc: intent.createdAtUtc,
          mapping: null,
        });
        if (old[0]) {
          if (old[0].metadata_json !== json)
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          return;
        }
        yield* stored(
          "local-intent-payload",
          sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${intent.intentId},${intent.memoryId},${yield* payloadCodec.encode(intent.payload)},${yield* headsCodec.encode(intent.payload.derivedFromMemoryRevisions)})`,
        );
        yield* stored(
          "local-intent-outbox",
          sql`INSERT INTO memory_outbox (id,space,memory_id,kind,status,metadata_json,payload_ref,next_attempt_at) VALUES (${`local:${intent.environmentId}:${intent.intentId}`},${space},${intent.memoryId},'admin','pending',${json},${intent.intentId},0)`,
        );
      }),
    );
  });
  const readLocalSummaryPayload = Effect.fn("MemoryStore.readLocalSummaryPayload")(function* (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) {
    const rows = yield* stored(
      "summary-local-payload-read",
      sql<{ body_json: string }>`
      SELECT p.body_json FROM memory_payloads p JOIN memory_outbox o ON o.space=p.space AND o.payload_ref=p.payload_ref
      WHERE o.id=${`local:${environmentId}:${intentId}`} AND o.status!='cancelled'
      AND p.space=${`_local:${environmentId}`} AND p.payload_ref=${intentId}`,
    );
    return rows[0]
      ? yield* stored("summary-local-payload-codec", payloadCodec.decode(rows[0].body_json, strict))
      : undefined;
  });
  const refreshLocalSummaryIntent = Effect.fn("MemoryStore.refreshLocalSummaryIntent")(function* (
    input: LocalMemoryIntent,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("summary-local-codec", decodeLocalIntent(input, strict));
        const source = intent.provenance.sourceThread;
        const watermark = intent.provenance.sourceWatermark;
        if (
          !source ||
          !watermark ||
          source.environmentId !== intent.environmentId ||
          intent.scope.kind !== "thread" ||
          (yield* threadCodec.encode(source)) !== (yield* threadCodec.encode(intent.scope.thread))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const id = `local:${intent.environmentId}:${intent.intentId}`;
        const rows = yield* stored(
          "summary-local-read",
          sql<{
            metadata_json: string;
            status: string;
          }>`SELECT metadata_json,status FROM memory_outbox WHERE id=${id}`,
        );
        if (!rows[0]) return yield* putLocalIntent(intent);
        const previous = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
        if (rows[0].status === "cancelled")
          return yield* new MemoryStoreConflict({ code: "forgotten" });
        if (
          previous.mapping ||
          previous.memoryId !== intent.memoryId ||
          !previous.provenance.sourceThread ||
          (yield* threadCodec.encode(previous.provenance.sourceThread)) !==
            (yield* threadCodec.encode(source))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        if (
          (previous.provenance.sourceWatermark?.throughSequence ?? 0) >= watermark.throughSequence
        )
          return;
        yield* stored(
          "summary-local-payload",
          sql`UPDATE memory_payloads SET body_json=${yield* payloadCodec.encode(intent.payload)},dependencies_json=${yield* headsCodec.encode(intent.payload.derivedFromMemoryRevisions)} WHERE space=${`_local:${intent.environmentId}`} AND payload_ref=${intent.intentId}`,
        );
        yield* stored(
          "summary-local-metadata",
          sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ kind: "localIntent", intentId: intent.intentId, environmentId: intent.environmentId, memoryId: intent.memoryId, scope: intent.scope, provenance: intent.provenance, assertionKind: intent.assertionKind, createdAtUtc: intent.createdAtUtc, mapping: null })} WHERE id=${id}`,
        );
      }),
    );
  });
  const materializeLocalIntentTx: MemoryStoreShape["materializeLocalIntentTx"] = Effect.fn(
    "MemoryStore.materializeLocalIntentTx",
  )(function* (input) {
    yield* Transaction;
    const ready = yield* stored(
      "local-binding-ready",
      sql`SELECT 1 FROM memory_compaction_state WHERE space=${input.memorySpaceId} AND published=1`,
    );
    if (!ready.length) return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    const id = `local:${input.environmentId}:${input.intentId}`;
    const rows = yield* stored(
      "local-intent",
      sql<{
        metadata_json: string;
        body_json: string;
      }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.id=${id} AND o.status!='cancelled'`,
    );
    const row = rows[0];
    if (!row) return yield* new MemoryStoreConflict({ code: "not_found" });
    const draft = yield* localMetadataCodec.decode(row.metadata_json, strict);
    if (draft.mapping && draft.mapping.memorySpaceId !== input.memorySpaceId)
      return yield* new MemoryStoreConflict({ code: "space_mismatch" });
    const mapping = draft.mapping ?? {
      memorySpaceId: input.memorySpaceId,
      operationId: input.operationId,
      revisionId: input.revisionId,
    };
    const payload = yield* payloadCodec.decode(row.body_json, strict);
    const operation = yield* stored(
      "materialize-codec",
      decodeOperation(
        {
          protocolVersion: 1,
          kind: "upsert",
          memorySpaceId: mapping.memorySpaceId,
          memoryId: draft.memoryId,
          operationId: mapping.operationId,
          originEnvironmentId: draft.environmentId,
          expectedHeads: [],
          revision: {
            memorySpaceId: mapping.memorySpaceId,
            memoryId: draft.memoryId,
            operationId: mapping.operationId,
            revisionId: mapping.revisionId,
            payloadRef: mapping.revisionId,
            parents: [],
            scope: draft.scope,
            assertionKind: draft.assertionKind,
            provenance: draft.provenance,
            createdAtUtc: draft.createdAtUtc,
          },
          payload,
        },
        strict,
      ),
    );
    yield* stored(
      "materialize-map",
      sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ ...draft, mapping })} WHERE id=${id}`,
    );
    return { operation, operationDigest: hashText(M.encodeMemoryOperation(operation)) };
  });
  const materializeLocalIntent = (input: IntentIdentityInput) =>
    transact(materializeLocalIntentTx(input));
  const completeLocalIntentTx: MemoryStoreShape["completeLocalIntentTx"] = Effect.fn(
    "MemoryStore.completeLocalIntentTx",
  )(function* (input) {
    yield* Transaction;
    const { operation: op, operationDigest } = input.materialized;
    const record = yield* receipt(op.memorySpaceId, op.operationId);
    if (
      !record ||
      record.operationDigest !== operationDigest ||
      op.kind !== "upsert" ||
      op.originEnvironmentId !== input.environmentId
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (
      record.receipt.outcome !== "rejected" &&
      !("hubSequence" in record.receipt && record.receipt.hubSequence !== null)
    ) {
      const sync = yield* stored(
        "intent-sync",
        sql`SELECT 1 FROM memory_outbox WHERE id=${`sync:${op.memorySpaceId}:${op.operationId}`} AND (operation_digest IS NULL OR operation_digest=${operationDigest})`,
      );
      if (!sync.length) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      yield* stored(
        "intent-sync-digest",
        sql`UPDATE memory_outbox SET operation_digest=${operationDigest} WHERE id=${`sync:${op.memorySpaceId}:${op.operationId}`} AND operation_digest IS NULL`,
      );
    }
    const rows = yield* stored(
      "intent-complete",
      sql`UPDATE memory_outbox SET status='completed',terminal_at=coalesce(terminal_at,${input.now}),claimed_by=NULL,claimed_until=NULL
      WHERE id=${`local:${input.environmentId}:${input.intentId}`} AND kind='admin' AND status!='cancelled'
      AND json_extract(metadata_json,'$.mapping.memorySpaceId')=${op.memorySpaceId}
      AND json_extract(metadata_json,'$.mapping.operationId')=${op.operationId}
      AND json_extract(metadata_json,'$.mapping.revisionId')=${op.revision.revisionId} RETURNING id`,
    );
    if (rows.length !== 1) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
  });
  return {
    putLocalIntent,
    readLocalSummaryPayload,
    refreshLocalSummaryIntent,
    materializeLocalIntentTx,
    materializeLocalIntent,
    completeLocalIntentTx,
  };
};

export type LocalIntents = ReturnType<typeof makeLocalIntents>;
