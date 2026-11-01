import * as NodeUtil from "node:util";
import * as M from "@goat/contracts";
import type { ImportStorePorts } from "../imports/MemoryImportTypes.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import type { ImportLineage } from "./ImportLineage.ts";
import {
  importBatchCodec,
  importDigestsCodec,
  importId,
  importItemCodec,
  importRegistrationCodec,
  importTime,
  scopeCodec,
  stored,
  suppressionKeyCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryCapacityError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  strict,
} from "./StoreModel.ts";

export const makeImports = (
  kernel: Pick<StoreKernel, "sql" | "withHubBudget">,
  coreReads: Pick<CoreReads, "loadAggregate" | "readOperation" | "receipt">,
  importLineage: Pick<
    ImportLineage,
    "readImportNoopResultTx" | "retireImportBatchesTx" | "shareImportNoopTx"
  >,
) => {
  const { sql, withHubBudget } = kernel;
  const { loadAggregate, readOperation, receipt } = coreReads;
  const { readImportNoopResultTx, retireImportBatchesTx, shareImportNoopTx } = importLineage;
  const readImportRegistrationTx: ImportStorePorts["readImportRegistrationTx"] = Effect.fnUntraced(
    function* (input) {
      yield* Transaction;
      const rows = yield* stored(
        "import-registration-read",
        input.by === "source"
          ? sql<{
              registration_json: string;
            }>`SELECT registration_json FROM memory_import_receipts WHERE space=${input.memorySpaceId} AND environment_id=${input.environmentId} AND record_kind='source' AND source_id=${input.sourceId}`
          : sql<{
              registration_json: string;
            }>`SELECT registration_json FROM memory_import_receipts WHERE space=${input.memorySpaceId} AND environment_id=${input.environmentId} AND record_kind='source'
        AND json_extract(registration_json,'$.slot.format')=${input.slot.format} AND json_extract(registration_json,'$.slot.rootSlot')=${input.slot.rootSlot}
        AND json_extract(registration_json,'$.slot.selection') IS ${input.slot.selection}`,
      );
      if (rows.length > 1) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (!rows[0]) return undefined;
      const r = yield* importRegistrationCodec.decode(rows[0].registration_json, strict);
      if (
        r.memorySpaceId !== input.memorySpaceId ||
        r.environmentId !== input.environmentId ||
        (input.by === "source" && r.sourceId !== input.sourceId)
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      return r;
    },
  );
  const writeImportRegistrationTx: ImportStorePorts["writeImportRegistrationTx"] =
    Effect.fnUntraced(function* (input) {
      yield* Transaction;
      const json = yield* importRegistrationCodec.encode(input.next);
      const next = yield* importRegistrationCodec.decode(json, strict);
      if (next.memorySpaceId !== input.memorySpaceId || next.environmentId !== input.environmentId)
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const old = yield* readImportRegistrationTx({
        ...input,
        by: "source",
        sourceId: next.sourceId,
      });
      const slot = yield* readImportRegistrationTx({ ...input, by: "slot", slot: next.slot });
      if (slot && slot.sourceId !== next.sourceId)
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      if (
        (old?.version ?? null) !== input.expectedVersion ||
        next.version !== (input.expectedVersion === null ? 0 : input.expectedVersion + 1)
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      if (
        old &&
        (!NodeUtil.isDeepStrictEqual(old.slot, next.slot) ||
          old.sourceLocator !== next.sourceLocator)
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (
        old?.session &&
        next.session?.sessionId === old.session.sessionId &&
        (next.session.newItems < old.session.newItems ||
          next.session.bodyBytes < old.session.bodyBytes ||
          !old.session.applied.every((a) =>
            next.session!.applied.some((b) => NodeUtil.isDeepStrictEqual(a, b)),
          ))
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      const observed =
        next.session?.createdAtUtc ?? (yield* importTime(yield* Clock.currentTimeMillis));
      yield* stored(
        "import-registration-write",
        sql`INSERT INTO memory_import_receipts(receipt_id,space,environment_id,record_kind,source_id,format,source_locator,parser_version,registration_json,observed_at_utc)
      VALUES (${importId(["source", next.memorySpaceId, next.environmentId, next.sourceId])},${next.memorySpaceId},${next.environmentId},'source',${next.sourceId},${next.source.format},${next.sourceLocator},${next.source.parserVersion},${json},${observed})
      ON CONFLICT(receipt_id) DO UPDATE SET registration_json=excluded.registration_json,parser_version=excluded.parser_version,observed_at_utc=excluded.observed_at_utc`,
      );
      return next;
    });
  const readImportBatchTx: ImportStorePorts["readImportBatchTx"] = Effect.fnUntraced(
    function* (input) {
      yield* Transaction;
      yield* retireImportBatchesTx(
        input.memorySpaceId,
        yield* Clock.currentTimeMillis,
        1,
        input.operationId,
      );
      const rows = yield* stored(
        "import-batch-read",
        sql<{
          completed_items_json: string;
          request_digest: string;
          source_id: string;
          observed_at_utc: string;
          result_ref: string | null;
        }>`SELECT completed_items_json,request_digest,source_id,observed_at_utc,result_ref FROM memory_import_receipts
      WHERE space=${input.memorySpaceId} AND environment_id=${input.environmentId} AND record_kind='batch' AND batch_operation_id=${input.operationId}`,
      );
      if (!rows[0]) return undefined;
      const b = yield* importBatchCodec.decode(rows[0].completed_items_json, strict);
      if (
        b.selectionDigest !== rows[0].request_digest ||
        (b.kind !== "retired" &&
          (b.memorySpaceId !== input.memorySpaceId ||
            b.environmentId !== input.environmentId ||
            b.operationId !== input.operationId ||
            b.sourceId !== rows[0].source_id ||
            b.createdAtUtc !== rows[0].observed_at_utc)) ||
        rows[0].result_ref !== (b.kind === "completed-noop-ref" ? b.resultRef : null)
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (b.kind === "completed-noop-ref") {
        const result = yield* readImportNoopResultTx(b);
        return {
          ...b,
          receipt: {
            operationId: b.operationId,
            sourceId: b.sourceId,
            sessionId: b.sessionId,
            state: "completed" as const,
            remaining: 0,
            sessionNewItems: b.sessionNewItems,
            sessionBodyBytes: b.sessionBodyBytes,
            items: result.items,
          },
        };
      }
      if (b.kind === "detailed") {
        const shared = yield* withHubBudget(
          shareImportNoopTx(b).pipe(
            Effect.flatMap((shared) =>
              Effect.gen(function* () {
                if (shared.resultRef !== null)
                  yield* stored(
                    "import-noop-convert",
                    sql`
              UPDATE memory_import_receipts SET completed_items_json=${shared.json},result_ref=${shared.resultRef}
              WHERE space=${b.memorySpaceId} AND environment_id=${b.environmentId} AND batch_operation_id=${b.operationId}`,
                  );
                return shared;
              }),
            ),
          ),
        );
        if (shared.resultRef !== null)
          return {
            ...b,
            kind: "completed-noop-ref" as const,
            resultRef: shared.resultRef,
            sessionNewItems: b.receipt.sessionNewItems,
            sessionBodyBytes: b.receipt.sessionBodyBytes,
          };
      }
      return b;
    },
  );
  const readImportReceiptTx: ImportStorePorts["readImportReceiptTx"] = Effect.fnUntraced(
    function* (input) {
      const b = yield* readImportBatchTx(input);
      return b && b.kind !== "retired" ? b.receipt : undefined;
    },
  );
  const readImportItemTx: ImportStorePorts["readImportItemTx"] = Effect.fnUntraced(
    function* (input) {
      yield* Transaction;
      const rows = yield* stored(
        "import-item-read",
        sql<{ registration_json: string }>`SELECT registration_json FROM memory_import_receipts
      WHERE space=${input.memorySpaceId} AND environment_id=${input.environmentId} AND record_kind='item' AND source_id=${input.sourceId} AND source_item_key=${input.sourceItemKey}`,
      );
      if (!rows[0]) return undefined;
      const item = yield* importItemCodec.decode(rows[0].registration_json, strict);
      if (
        item.memorySpaceId !== input.memorySpaceId ||
        item.environmentId !== input.environmentId ||
        item.sourceId !== input.sourceId ||
        item.sourceItemKey !== input.sourceItemKey
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      return item;
    },
  );
  const commitImportItemTx: ImportStorePorts["commitImportItemTx"] = Effect.fnUntraced(
    function* (input) {
      yield* Transaction;
      const batch = yield* importBatchCodec.decode(
        yield* importBatchCodec.encode(input.batch),
        strict,
      );
      if (batch.kind !== "detailed")
        return yield* new MemoryStoreConflict({ code: "invalid_output" });
      const guard = yield* readImportBatchTx(batch);
      // Digest is checked before retirement: changed digest must never become not_found.
      if (guard && guard.selectionDigest !== batch.selectionDigest)
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      if (guard?.kind === "retired") return yield* new MemoryStoreConflict({ code: "not_found" });
      if (guard?.kind === "completed-noop-ref") {
        const result = guard.receipt.items.find(
          (s) => s.sourceItemKey === input.next.sourceItemKey,
        );
        if (!result) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        return result;
      }
      const next = yield* importItemCodec.decode(yield* importItemCodec.encode(input.next), strict);
      const selection = batch.selections.find(
        (s) => s.selector.sourceItemKey === next.sourceItemKey,
      );
      if (
        !selection?.result ||
        next.memorySpaceId !== batch.memorySpaceId ||
        next.environmentId !== batch.environmentId ||
        next.sourceId !== batch.sourceId ||
        next.memoryId !== selection.memoryId
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (guard?.kind === "detailed") {
        const frozen = (s: typeof selection) => ({
          selector: s.selector,
          memoryId: s.memoryId,
          operationId: s.operationId,
          revisionId: s.revisionId,
          result: null,
        });
        if (
          guard.sourceId !== batch.sourceId ||
          guard.sessionId !== batch.sessionId ||
          !NodeUtil.isDeepStrictEqual(guard.selections.map(frozen), batch.selections.map(frozen))
        )
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        const done = guard.selections.find(
          (s) => s.selector.sourceItemKey === next.sourceItemKey,
        )?.result;
        if (done) return done;
        if (
          !guard.selections.every((s, i) =>
            s.result === null
              ? s.selector.sourceItemKey === next.sourceItemKey ||
                batch.selections[i]!.result === null
              : NodeUtil.isDeepStrictEqual(s.result, batch.selections[i]!.result) &&
                NodeUtil.isDeepStrictEqual(s.observation, batch.selections[i]!.observation) &&
                s.settled === batch.selections[i]!.settled,
          )
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
      } else if (batch.selections.filter((s) => s.result !== null).length !== 1) {
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      }
      const registration = yield* readImportRegistrationTx({ ...batch, by: "source" });
      if (
        !registration ||
        registration.version !== input.registrationVersion ||
        registration.session?.sessionId !== batch.sessionId
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      const session = registration.session;
      if (Date.parse(session.expiresAtUtc) <= (yield* Clock.currentTimeMillis))
        return yield* new MemoryStoreConflict({ code: "not_found" });
      const previous = yield* readImportItemTx(next);
      if (!NodeUtil.isDeepStrictEqual(previous ?? null, input.previous))
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      yield* input.commitIntent;
      const digestRows = yield* stored(
        "import-digests-read",
        sql<{ accepted_content_fingerprints_json: string | null }>`
        SELECT accepted_content_fingerprints_json FROM memory_import_receipts WHERE receipt_id=${importId(["item", next.memorySpaceId, next.environmentId, next.sourceId, next.sourceItemKey])}`,
      );
      const digests = digestRows[0]?.accepted_content_fingerprints_json
        ? yield* importDigestsCodec.decode(digestRows[0].accepted_content_fingerprints_json, strict)
        : [];
      const allocatedDigests = yield* importDigestsCodec.encode(
        [...new Set([...digests, input.contentFingerprint])].sort(),
      );
      // Item, detailed receipt and session CAS share the intent/quota/outbox journal.
      if (!input.preserveItem)
        yield* stored(
          "import-item-write",
          sql`INSERT INTO memory_import_receipts(receipt_id,space,environment_id,record_kind,source_id,source_item_key,memory_id,scope_json,registration_json,outcome,observed_at_utc)
      VALUES (${importId(["item", next.memorySpaceId, next.environmentId, next.sourceId, next.sourceItemKey])},${next.memorySpaceId},${next.environmentId},'item',${next.sourceId},${next.sourceItemKey},${next.memoryId},${yield* scopeCodec.encode(next.scope)},${yield* importItemCodec.encode(next)},${next.outcome},${batch.createdAtUtc})
      ON CONFLICT(receipt_id) DO UPDATE SET registration_json=excluded.registration_json,memory_id=excluded.memory_id,scope_json=excluded.scope_json,outcome=excluded.outcome,observed_at_utc=excluded.observed_at_utc`,
        );
      yield* stored(
        "import-digests-write",
        sql`UPDATE memory_import_receipts SET accepted_content_fingerprints_json=${allocatedDigests}
        WHERE receipt_id=${importId(["item", next.memorySpaceId, next.environmentId, next.sourceId, next.sourceItemKey])}`,
      );
      const charged =
        selection.result.outcome === "created" ||
        selection.result.outcome === "revised" ||
        selection.result.outcome === "conflicted";
      const op = yield* readOperation(batch.memorySpaceId, selection.operationId);
      const bodyBytes =
        charged && op?.kind === "upsert" ? new TextEncoder().encode(op.payload.text).length : 0;
      const observed = session.applied.some(
        (a) =>
          a.sourceItemKey === next.sourceItemKey &&
          a.sourceFingerprint === selection.selector.sourceFingerprint,
      );
      // A rejected/suppressed observation allocates metadata, not an accepted body charge.
      // Keep its immutable zero-byte observation while a later successful retry adds its charge.
      const previouslyCharged = session.applied.some(
        (a) =>
          a.sourceItemKey === next.sourceItemKey &&
          a.sourceFingerprint === selection.selector.sourceFingerprint &&
          a.bodyBytes > 0,
      );
      const chargeNow = charged && !previouslyCharged;
      const nextSession = {
        ...session,
        newItems:
          session.newItems + Number(!previouslyCharged && selection.result.outcome === "created"),
        bodyBytes: session.bodyBytes + (chargeNow ? bodyBytes : 0),
        applied:
          observed && !chargeNow
            ? session.applied
            : [
                ...session.applied,
                {
                  sourceItemKey: next.sourceItemKey,
                  sourceFingerprint: selection.selector.sourceFingerprint,
                  bodyBytes,
                },
              ],
      };
      for (const [dimension, current, limit] of [
        ["import_session_items", nextSession.newItems, M.MEMORY_IMPORT_SESSION_MAX_NEW_ITEMS],
        ["import_session_bytes", nextSession.bodyBytes, M.MEMORY_IMPORT_SESSION_MAX_BODY_BYTES],
      ] as const)
        if (
          current > limit &&
          current > (dimension === "import_session_items" ? session.newItems : session.bodyBytes)
        )
          return yield* new MemoryCapacityError({ dimension, current, limit });
      const observation =
        selection.result.outcome === "noop"
          ? (next.pending ?? next.accepted)
          : ["created", "revised", "conflicted", "aliased"].includes(selection.result.outcome)
            ? next.pending
            : null;
      const approval = observation
        ? yield* receipt(batch.memorySpaceId, observation.operationId)
        : undefined;
      const settled =
        approval !== undefined &&
        (approval.receipt.outcome === "rejected" ||
          ("hubSequence" in approval.receipt && approval.receipt.hubSequence !== null));
      const persisted = {
        ...batch,
        selections: batch.selections.map((s) =>
          s !== selection
            ? s
            : {
                selector: s.selector,
                memoryId: s.memoryId,
                operationId: s.operationId,
                revisionId: s.revisionId,
                result: s.result,
                ...(observation ? { observation, settled } : {}),
              },
        ),
        receipt: {
          ...batch.receipt,
          sessionNewItems: nextSession.newItems,
          sessionBodyBytes: nextSession.bodyBytes,
        },
      };
      yield* writeImportRegistrationTx({
        ...batch,
        next: { ...registration, version: registration.version + 1, session: nextSession },
        expectedVersion: registration.version,
      });
      const shared = yield* shareImportNoopTx(persisted);
      yield* stored(
        "import-batch-write",
        sql`INSERT INTO memory_import_receipts(receipt_id,space,environment_id,record_kind,source_id,batch_operation_id,request_digest,completed_items_json,observed_at_utc,result_ref)
      VALUES (${importId(["batch", batch.memorySpaceId, batch.environmentId, batch.operationId])},${batch.memorySpaceId},${batch.environmentId},'batch',${batch.sourceId},${batch.operationId},${batch.selectionDigest},${shared.json},${batch.createdAtUtc},${shared.resultRef})
      ON CONFLICT(receipt_id) DO UPDATE SET completed_items_json=excluded.completed_items_json,observed_at_utc=excluded.observed_at_utc,result_ref=excluded.result_ref`,
      );
      return selection.result;
    },
  );
  const findImportMatchTx: ImportStorePorts["findImportMatchTx"] = Effect.fn(
    "MemoryStore.findImportMatchTx",
  )(function* (input) {
    yield* Transaction;
    const dummy = M.MemoryId.make("00000000-0000-4000-8000-000000000000");
    let live:
      | {
          readonly kind: "live";
          readonly memoryId: M.MemoryId;
          readonly revision: M.MemoryRevision;
          readonly payload: M.MemoryPayload;
        }
      | undefined;
    for (const record of [
      {
        memorySpaceId: input.memorySpaceId,
        memoryId: dummy,
        kind: "sourceKey" as const,
        sourceKey: input.source,
      },
      {
        memorySpaceId: input.memorySpaceId,
        memoryId: dummy,
        kind: "content" as const,
        content: input.content,
      },
    ]) {
      const key = M.memoryImportLineageRecordKey(record);
      const suppressionKey = hashText(
        yield* suppressionKeyCodec.encode(
          record.kind === "sourceKey"
            ? { kind: record.kind, value: record.sourceKey }
            : { kind: record.kind, value: record.content },
        ),
      );
      const suppressed = yield* stored(
        "import-suppression-lookup",
        sql<{ memory_id: string }>`
        SELECT memory_id FROM memory_import_keys WHERE space=${input.memorySpaceId} AND key_kind=${record.kind} AND key=${suppressionKey}`,
      );
      if (suppressed[0])
        return {
          kind:
            record.kind === "sourceKey"
              ? ("source_suppressed" as const)
              : ("content_suppressed" as const),
          memoryId: M.MemoryId.make(suppressed[0].memory_id),
        };
      const rows = yield* stored(
        "import-lineage-lookup",
        sql<{ memory_id: string }>`
        SELECT memory_id FROM memory_import_lineage WHERE space=${input.memorySpaceId} AND kind=${record.kind} AND key=${key}
        ORDER BY memory_id`,
      );
      // Check every matching identity's delete fence before choosing a live exact-copy target.
      for (const row of rows) {
        const memoryId = M.MemoryId.make(row.memory_id);
        const current = yield* loadAggregate(input.memorySpaceId, memoryId, { heads: true }, {});
        if (current.tombstone)
          return {
            kind:
              record.kind === "sourceKey"
                ? ("source_suppressed" as const)
                : ("content_suppressed" as const),
            memoryId,
          };
        if (current.pendingForget) return { kind: "pending_forget" as const, memoryId };
        if (current.item?.status !== "active" || current.heads.length !== 1) continue;
        const head = current.revisions.find(
          (pair) => pair.revision.revisionId === current.heads[0],
        );
        if (head?.payload)
          live ??= { kind: "live", memoryId, revision: head.revision, payload: head.payload };
      }
    }
    return live ?? { kind: "none" as const };
  });
  return {
    readImportRegistrationTx,
    writeImportRegistrationTx,
    readImportBatchTx,
    readImportReceiptTx,
    readImportItemTx,
    commitImportItemTx,
    findImportMatchTx,
  };
};

export type Imports = ReturnType<typeof makeImports>;
