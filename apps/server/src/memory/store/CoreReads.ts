import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  boundaryCodec,
  codec,
  compactCodec,
  contentCodec,
  decodeConflict,
  decodeHistoryRevision,
  decodeItem,
  decodeMemoryId,
  decodeOperation,
  decodePendingForget,
  decodeRevision,
  decodeTombstone,
  exclusionsCodec,
  fenceCodec,
  headsCodec,
  identityCodec,
  importTime,
  lineageCodec,
  metadataCodec,
  payloadCodec,
  projectionCodec,
  provenanceCodec,
  receiptCodec,
  resolutionCodec,
  resolutionPayloadCodec,
  resolutionReasonsCodec,
  scopeCodec,
  sourceKeysCodec,
  stored,
  suppressionCodec,
  workRows,
} from "./StoreCodecs.ts";
import type { HistoryRevisionRow, WorkRow } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryStoreConflict,
  Metadata,
  hasSourceEvidence,
  sameHeadSet,
  strict,
} from "./StoreModel.ts";
import type { MemoryHistorySelection, MemoryPayloadSelection } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

const resolutionHeadsCodec = codec(
  Schema.Array(
    Schema.Struct({
      revision: M.MemoryRevision,
      payload: Schema.NullOr(M.MemoryPayload),
    }),
  ),
);

export const makeCoreReads = (kernel: Pick<StoreKernel, "sql" | "transact">) => {
  const { sql, transact } = kernel;
  const receipt = Effect.fn("MemoryStore.receipt")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryOperationId,
  ) {
    const rows = yield* stored(
      "receipt",
      sql<{ operation_digest: string; receipt_json: string }>`
      SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${space} AND operation_id=${id}
      UNION ALL SELECT operation_digest,receipt_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${id}
      UNION ALL SELECT json_extract(record_json,'$.receipt.operationDigest') AS operation_digest,json_extract(record_json,'$.receipt') AS receipt_json FROM memory_import_keys WHERE space=${space} AND key_kind='hubReceipt' AND key=${id} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      operationDigest: row.operation_digest,
      receipt: yield* stored("receipt-codec", receiptCodec.decode(row.receipt_json, strict)),
    };
  });
  const readAncestry = Effect.fn("MemoryStore.readAncestry")(function* (
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
    parents: ReadonlyArray<M.MemoryRevisionId>,
  ) {
    const states = yield* stored(
      "ancestry-boundary",
      sql<{
        boundary_json: string | null;
        retained_revision_boundary: number;
      }>`SELECT boundary_json,retained_revision_boundary FROM memory_compaction_state WHERE space=${space} AND published=1`,
    );
    const state = states[0];
    const causalBoundary = state?.boundary_json
      ? yield* boundaryCodec.decode(state.boundary_json, strict)
      : undefined;
    const result = yield* Effect.forEach(parents, (revisionId) =>
      Effect.gen(function* () {
        const rows = yield* stored(
          "ancestry-revision",
          sql<{
            memory_id: string;
            parents_json: string;
            missing_parents_json: string | null;
          }>`SELECT r.memory_id,r.parents_json,p.missing_parents_json FROM memory_revisions r LEFT JOIN memory_inbox_pending p ON p.space=r.space AND p.operation_id=r.operation_id AND p.record_kind='operation' WHERE r.space=${space} AND r.revision_id=${revisionId}`,
        );
        const row = rows[0];
        if (row) {
          const owner = yield* stored("ancestry-owner", decodeMemoryId(row.memory_id));
          if (owner === memoryId && row.missing_parents_json !== null)
            return {
              revisionId,
              status: "parked" as const,
              missingParents: yield* headsCodec.decode(row.missing_parents_json, strict),
            };
          return owner !== memoryId
            ? { revisionId, status: "crossMemory" as const, memoryId: owner }
            : {
                revisionId,
                status: "retained" as const,
                parents: yield* headsCodec.decode(row.parents_json, strict),
              };
        }
        // Exact durable revision membership, rather than timestamps or the existence of a checkpoint.
        const receipts = yield* stored(
          "ancestry-compact",
          sql<{
            compact_json: string;
          }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND json_extract(compact_json,'$.revisionId')=${revisionId}`,
        );
        for (const receipt of receipts) {
          const record = yield* compactCodec.decode(receipt.compact_json, strict);
          if (record.receipt.outcome === "rejected") continue;
          if (record.receipt.memoryId !== memoryId)
            return {
              revisionId,
              status: "crossMemory" as const,
              memoryId: record.receipt.memoryId,
            };
          if (
            causalBoundary &&
            record.receipt.hubSequence !== null &&
            record.receipt.hubSequence <= causalBoundary.checkpointSequence
          )
            return { revisionId, status: "compacted" as const, boundary: causalBoundary };
        }
        return { revisionId, status: "missing" as const };
      }),
    );
    return {
      causalBoundary,
      retentionFloor: state?.retained_revision_boundary ?? 0,
      parents: result,
    };
  });
  const readPending = Effect.fnUntraced(function* (space: M.MemorySpaceId, id: M.MemoryId) {
    const rows = yield* stored(
      "pending-forget",
      sql`SELECT space AS memorySpaceId,memory_id AS memoryId,operation_id AS operationId,requested_at_utc AS requestedAtUtc,attempts,last_failure_code AS lastFailureCode,operation_digest AS operationDigest,submission_state AS submissionState FROM memory_pending_forget_intents WHERE space=${space} AND memory_id=${id}`,
    );
    return rows[0]
      ? yield* stored("pending-forget-codec", decodePendingForget(rows[0], strict))
      : undefined;
  });
  const readItem = Effect.fnUntraced(function* (space: M.MemorySpaceId, id: M.MemoryId) {
    const rows = yield* stored(
      "item",
      sql<{
        item_json: string;
        heads_json: string;
        generation: number;
        body_json: string | null;
      }>`SELECT i.item_json,i.heads_json,i.generation,p.body_json FROM memory_items i LEFT JOIN memory_payloads p ON p.space=i.space AND p.payload_ref=i.payload_ref WHERE i.space=${space} AND i.memory_id=${id}`,
    );
    const row = rows[0];
    if (!row) return undefined;
    const projection = yield* projectionCodec.decode(row.item_json, strict);
    const item =
      projection.status === "active"
        ? row.body_json
          ? yield* stored(
              "item-codec",
              decodeItem(
                { ...projection, payload: yield* payloadCodec.decode(row.body_json, strict) },
                strict,
              ),
            )
          : yield* stored(
              "item-codec",
              decodeItem(
                {
                  memorySpaceId: space,
                  memoryId: id,
                  status: "blocked",
                  scope: projection.scope,
                  pendingSync: projection.pendingSync,
                  failureCode: "source_invalidated",
                  localAvailability: {
                    exposure: "held",
                    reasons: ["dependency_invalidated"],
                    deferred: [],
                    cleanupPending: true,
                  },
                },
                strict,
              ),
            )
        : yield* stored("item-codec", decodeItem(projection, strict));
    const unsent = yield* stored(
      "pending-sync-read",
      sql`SELECT 1 FROM memory_outbox WHERE space=${space} AND memory_id=${id} AND kind IN ('sync','revert_intent') AND status IN ('pending','retry','running') LIMIT 1`,
    );
    return {
      item: { ...item, pendingSync: unsent.length > 0 },
      heads: yield* headsCodec.decode(row.heads_json),
      generation: row.generation,
    };
  });
  const readResolutionSnapshot: MemoryStoreShape["readResolutionSnapshot"] = Effect.fn(
    "MemoryStore.readResolutionSnapshot",
  )(function* (space, memoryId) {
    const rows = yield* stored(
      "resolution-snapshot",
      sql<{
        status: M.MemoryItem["status"] | null;
        heads_json: string | null;
        generation: number | null;
        reasons_json: string | null;
        fence_json: string | null;
        tombstone: number;
        pending_forget: number;
      }>`SELECT i.status,i.heads_json,i.generation,json_extract(i.availability_json,'$.reasons') AS reasons_json,l.fence_json,
      EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${space} AND t.memory_id=${memoryId}) AS tombstone,
      EXISTS(SELECT 1 FROM memory_pending_forget_intents p WHERE p.space=${space} AND p.memory_id=${memoryId}) AS pending_forget
      FROM (SELECT 1) LEFT JOIN memory_items i ON i.space=${space} AND i.memory_id=${memoryId}
      LEFT JOIN memory_identity_ledger l ON l.space=${space} AND l.memory_id=${memoryId}`,
    );
    const row = rows[0]!;
    return {
      memorySpaceId: space,
      memoryId,
      status: row.status,
      heads: row.heads_json ? yield* headsCodec.decode(row.heads_json, strict) : [],
      generation: row.generation ?? 0,
      reasons: row.reasons_json
        ? yield* resolutionReasonsCodec.decode(row.reasons_json, strict)
        : [],
      tombstone: row.tombstone !== 0,
      pendingForget: row.pending_forget !== 0,
      fence: row.fence_json ? yield* fenceCodec.decode(row.fence_json, strict) : undefined,
    };
  });
  const readResolutionHeads: MemoryStoreShape["readResolutionHeads"] = Effect.fn(
    "MemoryStore.readResolutionHeads",
  )(function* (input) {
    // Generation input is restricted to the current frontier, never the revision history.
    // The existing conflict set carries the bound; reject unbounded caller selections.
    if (
      !Number.isSafeInteger(input.expectedGeneration) ||
      input.expectedGeneration < 0 ||
      !Number.isSafeInteger(input.maxItems) ||
      input.maxItems < 1 ||
      input.maxItems > M.MEMORY_PAGE_MAX_ITEMS ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > M.MEMORY_DEFERRED_SWEEP_MAX_BYTES ||
      input.heads.length === 0 ||
      input.heads.length > input.maxItems ||
      new Set(input.heads).size !== input.heads.length
    )
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    return yield* transact(
      Effect.gen(function* () {
        const snapshot = yield* readResolutionSnapshot(input.memorySpaceId, input.memoryId);
        if (
          snapshot.generation !== input.expectedGeneration ||
          snapshot.tombstone ||
          snapshot.pendingForget ||
          snapshot.status !== "quarantined" ||
          snapshot.reasons.some((reason) =>
            [
              "scanner_pending",
              "secret_detected",
              "missing_parent",
              "dependency_invalidated",
              "forget_pending",
            ].includes(reason),
          ) ||
          !sameHeadSet(snapshot.heads, input.heads)
        )
          return yield* new MemoryStoreConflict({ code: "conflict_changed" });
        // Check selected payload lengths at the PK boundary before loading bodies. This reads
        // only the requested frontier, irrespective of revision history. The final budget is
        // the UTF-8 JSON encoding of the returned revision/payload array (including metadata).
        const sizes = yield* stored(
          "resolution-head-byte-budget",
          sql<{
            bytes: number;
          }>`SELECT coalesce(sum(coalesce(length(CAST(p.body_json AS BLOB)),0)),0) AS bytes
          FROM json_each(${yield* headsCodec.encode(input.heads)}) selected CROSS JOIN memory_revisions r
          LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
          WHERE r.space=${input.memorySpaceId} AND r.revision_id=selected.value AND r.memory_id=${input.memoryId}`,
        );
        if ((sizes[0]?.bytes ?? 0) > input.maxBytes)
          return yield* new MemoryStoreConflict({ code: "invalid_output" });
        const rows = yield* stored(
          "resolution-heads",
          sql<{
            revision_id: string;
            operation_id: string;
            parents_json: string;
            scope_json: string;
            assertion_kind: string;
            provenance_json: string;
            payload_ref: string | null;
            created_at: number;
            body_json: string | null;
          }>`SELECT r.revision_id,r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,r.payload_ref,r.created_at,p.body_json
        FROM json_each(${yield* headsCodec.encode(input.heads)}) selected CROSS JOIN memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref
        WHERE r.space=${input.memorySpaceId} AND r.revision_id=selected.value AND r.memory_id=${input.memoryId}`,
        );
        if (rows.length !== input.heads.length)
          return yield* new MemoryStoreConflict({ code: "missing_parent" });
        const result = yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const revision = yield* stored(
              "revision-codec",
              decodeRevision(
                {
                  memorySpaceId: input.memorySpaceId,
                  memoryId: input.memoryId,
                  revisionId: row.revision_id,
                  operationId: row.operation_id,
                  parents: yield* headsCodec.decode(row.parents_json),
                  scope: yield* scopeCodec.decode(row.scope_json),
                  assertionKind: row.assertion_kind,
                  provenance: yield* provenanceCodec.decode(row.provenance_json),
                  payloadRef: row.payload_ref ?? row.revision_id,
                  createdAtUtc: yield* importTime(row.created_at),
                },
                strict,
              ),
            );
            return {
              revision,
              payload: row.body_json ? yield* payloadCodec.decode(row.body_json, strict) : null,
            };
          }),
        );
        if (
          new TextEncoder().encode(
            yield* stored("resolution-head-encoding", resolutionHeadsCodec.encode(result)),
          ).length > input.maxBytes
        )
          return yield* new MemoryStoreConflict({ code: "invalid_output" });
        return result;
      }),
    );
  });
  /** Admission reads only the revision metadata and payload bodies its selection requires. */
  const loadSelectedRevisions = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
    heads: ReadonlyArray<M.MemoryRevisionId>,
    visible: boolean,
    blocked: boolean,
    payloads: MemoryPayloadSelection,
    history?: MemoryHistorySelection,
  ) {
    const wanted = new Set<string>([
      ...(payloads.heads ? heads : []),
      ...(payloads.revisionIds ?? []),
    ]);
    const r = history?.revision;
    const wantedMetadata = new Set<string>([
      ...wanted,
      ...(history?.metadataRevisionIds ?? []),
      ...(r ? [r.revisionId, ...r.parents] : []),
    ]);
    let rows: ReadonlyArray<HistoryRevisionRow>;
    if (
      history === undefined ||
      (payloads.when !== undefined && payloads.when !== hasSourceEvidence)
    ) {
      rows = yield* stored(
        "revisions",
        sql<HistoryRevisionRow>`SELECT r.*,NULL AS body_json FROM memory_revisions r WHERE r.space=${space} AND r.memory_id=${id}`,
      );
    } else if (payloads.when === hasSourceEvidence) {
      rows = yield* stored(
        "revisions",
        sql<HistoryRevisionRow>`SELECT r.*,NULL AS body_json FROM memory_revisions r WHERE r.space=${space} AND r.memory_id=${id} AND ((instr(r.provenance_json,'"sourceThread"')>0 AND instr(r.provenance_json,'"sourceWatermark"')>0) ${history.importLineage ? sql`OR instr(r.provenance_json,'"importSource"')>0` : sql``} ${wantedMetadata.size ? sql`OR r.revision_id IN ${sql.in([...wantedMetadata])}` : sql``})`,
      );
    } else if (wantedMetadata.size === 0) {
      return [];
    } else {
      rows = yield* stored(
        "revisions",
        sql<HistoryRevisionRow>`SELECT r.*,NULL AS body_json FROM memory_revisions r WHERE r.space=${space} AND r.memory_id=${id} AND r.revision_id IN ${sql.in([...wantedMetadata])}`,
      );
      if (r && (r.parents.length > 0 || heads.length > 0)) {
        // The narrow read is exact only for a revision that extends current heads and
        // that no stored revision names as a parent: heads are maximal, so a head is
        // then superseded exactly when it is a direct parent. Anything else, such as
        // a branch from an older revision or an ancestor arriving after its child,
        // walks the whole DAG as before.
        const fullDagNeeded =
          blocked ||
          r.parents.some((parent) => !heads.includes(parent)) ||
          rows.some((row) => row.revision_id === r.revisionId) ||
          (yield* stored(
            "revisions-child",
            sql`SELECT 1 FROM memory_revisions WHERE space=${space} AND memory_id=${id} AND instr(parents_json,${`"${r.revisionId}"`})>0 LIMIT 1`,
          )).length > 0 ||
          (yield* stored(
            "revisions-pending",
            sql`SELECT 1 FROM memory_inbox_pending WHERE space=${space} AND memory_id=${id} AND record_kind='operation' LIMIT 1`,
          )).length > 0;
        if (fullDagNeeded) {
          rows = yield* stored(
            "revisions",
            sql<HistoryRevisionRow>`SELECT r.*,NULL AS body_json FROM memory_revisions r WHERE r.space=${space} AND r.memory_id=${id}`,
          );
        }
      }
    }
    const decoded = yield* Effect.forEach(rows, (row) =>
      decodeHistoryRevision(row, space, id, false),
    );
    if (!visible) return decoded;
    // The stored payload_ref decides the join, exactly as the full read's LEFT JOIN does.
    const refs = decoded.map(({ revision }, index) =>
      wanted.has(revision.revisionId) || payloads.when?.(revision) === true
        ? rows[index]!.payload_ref
        : null,
    );
    const unique = [...new Set(refs.filter((ref) => ref !== null))];
    const bodies = new Map<string, string | null>();
    for (let start = 0; start < unique.length; start += 500) {
      const chunk = unique.slice(start, start + 500);
      const found = yield* stored(
        "revision-payloads",
        sql<{
          payload_ref: string;
          body_json: string | null;
        }>`SELECT payload_ref,body_json FROM memory_payloads WHERE space=${space} AND payload_ref IN ${sql.in(chunk)}`,
      );
      for (const row of found) bodies.set(row.payload_ref, row.body_json);
    }
    return yield* Effect.forEach(decoded, (pair, index) =>
      Effect.gen(function* () {
        const ref = refs[index];
        const body = ref === null || ref === undefined ? undefined : bodies.get(ref);
        return body
          ? {
              revision: pair.revision,
              payload: yield* stored("payload-codec", payloadCodec.decode(body, strict)),
            }
          : pair;
      }),
    );
  });
  const loadAggregate = Effect.fn("MemoryStore.loadAggregate")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
    payloads?: MemoryPayloadSelection,
    history?: MemoryHistorySelection,
  ) {
    const item = yield* readItem(space, id);
    const visible = item?.item.status !== "forgotten";
    const blocked =
      item?.item.status === "blocked" &&
      (item.item.failureCode === "missing_parent" ||
        item.item.failureCode === "source_invalidated");
    const revisions =
      payloads === undefined
        ? yield* Effect.forEach(
            yield* stored(
              "revisions",
              sql<HistoryRevisionRow>`
      SELECT r.space,r.revision_id,r.memory_id,r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,r.payload_ref,r.created_at,p.body_json FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.memory_id=${id}`,
            ),
            (row) => decodeHistoryRevision(row, space, id, visible),
          )
        : yield* loadSelectedRevisions(
            space,
            id,
            item?.heads ?? [],
            visible,
            blocked,
            payloads,
            history,
          );
    const tombstones = yield* stored(
      "tombstone",
      sql<{
        delete_operation_id: string;
        deleting_environment_id: string;
        deleted_at: number;
        suppressed_source_keys_json: string;
        suppressed_content_json: string;
        source_exclusions_json: string;
      }>`SELECT * FROM memory_tombstones WHERE space=${space} AND memory_id=${id}`,
    );
    const t = tombstones[0];
    const tombstone = t
      ? yield* stored(
          "tombstone-codec",
          Effect.gen(function* () {
            return yield* decodeTombstone(
              {
                memorySpaceId: space,
                memoryId: id,
                deleteOperationId: t.delete_operation_id,
                deletingEnvironmentId: t.deleting_environment_id,
                deletedAtUtc: yield* importTime(t.deleted_at),
                suppressedSourceKeys: yield* sourceKeysCodec.decode(t.suppressed_source_keys_json),
                suppressedContent: yield* contentCodec.decode(t.suppressed_content_json),
                sourceExclusions: yield* exclusionsCodec.decode(t.source_exclusions_json),
              },
              strict,
            );
          }),
        )
      : undefined;
    const conflictRows =
      history !== undefined && history.conflictId === undefined
        ? []
        : yield* stored(
            "conflicts",
            sql<{
              conflict_id: string;
              heads_json: string;
              status: string;
              failure_code: string | null;
            }>`SELECT * FROM memory_conflicts WHERE space=${space} AND memory_id=${id}
        ${history === undefined ? sql`` : sql`AND conflict_id=${history.conflictId}`}`,
          );
    const conflicts = yield* stored(
      "conflict-codec",
      Effect.forEach(conflictRows, (row) =>
        Effect.gen(function* () {
          return yield* decodeConflict(
            {
              conflictId: row.conflict_id,
              memorySpaceId: space,
              memoryId: id,
              heads: yield* headsCodec.decode(row.heads_json),
              status: row.status,
              ...(row.failure_code ? { failureCode: row.failure_code } : {}),
            },
            strict,
          );
        }),
      ),
    );
    const resolutionRows =
      history !== undefined && history.resolutionId === undefined
        ? []
        : yield* stored(
            "resolutions",
            sql<{
              resolution_json: string;
            }>`SELECT resolution_json FROM memory_resolutions WHERE space=${space} AND memory_id=${id}
        ${history === undefined ? sql`` : sql`AND resolution_id=${history.resolutionId}`}`,
          );
    const resolutions = yield* stored(
      "resolution-codec",
      Effect.forEach(resolutionRows, (row) => resolutionCodec.decode(row.resolution_json, strict)),
    );
    const identities = yield* stored(
      "identity",
      sql<{
        identity_json: string;
        fence_json: string;
      }>`SELECT identity_json,fence_json FROM memory_identity_ledger WHERE space=${space} AND memory_id=${id}`,
    );
    const identity = identities[0];
    return {
      memorySpaceId: space,
      memoryId: id,
      item: item?.item,
      heads: item?.heads ?? [],
      generation: item?.generation ?? 0,
      revisions,
      tombstone,
      conflicts,
      resolutions,
      identity: identity
        ? yield* stored("identity-codec", identityCodec.decode(identity.identity_json, strict))
        : undefined,
      fence: identity
        ? yield* stored("fence-codec", fenceCodec.decode(identity.fence_json, strict))
        : undefined,
      pendingForget: yield* readPending(space, id),
    };
  });
  const readImportLineage = Effect.fn("MemoryStore.readImportLineage")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    const rows = yield* stored(
      "lineage-read",
      sql<{ record_json: string }>`
      SELECT record_json FROM memory_import_lineage WHERE space=${space} AND memory_id=${id}
      ORDER BY kind,key`,
    );
    return yield* Effect.forEach(rows, (row) => lineageCodec.decode(row.record_json, strict));
  });
  const readSuppressions = Effect.fn("MemoryStore.readSuppressions")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    const rows = yield* stored(
      "suppression-read",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND memory_id=${id} AND key_kind IN ('sourceKey','content','sourceExclusion') ORDER BY key_kind,key`,
    );
    return yield* Effect.forEach(rows, (row) => suppressionCodec.decode(row.record_json, strict));
  });
  const logicalBytes = Effect.fn("MemoryStore.logicalBytes")(function* () {
    const rows = yield* stored(
      "logical-bytes",
      sql<{ bytes: number }>`SELECT
      (SELECT coalesce(sum(length(CAST(body_json AS BLOB))),0) FROM memory_payloads)+
      (SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))+length(CAST(receipt_json AS BLOB))),0) FROM memory_events)+
      (SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))),0) FROM memory_inbox_pending)+
      (SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_keys)+
      (SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_lineage)+
      (SELECT coalesce(sum(reserve_bytes),0) FROM memory_identity_ledger)+
      (SELECT coalesce(sum(value),0) FROM memory_quota_counters WHERE space='_hub_global' AND dimension='import_metadata' AND scope_key='')+
      (SELECT coalesce(sum(value),0) FROM memory_quota_counters WHERE dimension='report_all_bytes' AND scope_key='') AS bytes`,
    );
    return rows[0]!.bytes;
  });
  const readOperation = Effect.fn("MemoryStore.readOperation")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryOperationId,
  ) {
    const rows = yield* stored(
      "operation-metadata",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_events WHERE memory_space_id=${space} AND operation_id=${id}`,
    );
    if (!rows[0]) return undefined;
    return yield* operationFromMetadata(yield* metadataCodec.decode(rows[0].metadata_json, strict));
  });
  const operationFromMetadata = Effect.fnUntraced(function* (metadata: typeof Metadata.Type) {
    if (metadata.kind === "forget")
      return yield* stored("operation-codec", decodeOperation(metadata, strict));
    if (!metadata.revision) return undefined;
    const rows = yield* stored(
      "operation-payload",
      sql<{
        body_json: string;
      }>`SELECT body_json FROM memory_payloads WHERE space=${metadata.memorySpaceId} AND payload_ref=${metadata.revision.payloadRef}`,
    );
    if (!rows[0]) return undefined;
    const payload = yield* payloadCodec.decode(rows[0].body_json, strict);
    if (metadata.kind === "resolve") {
      if (!metadata.resolution) return undefined;
      const judgments = yield* stored(
        "operation-judgment",
        sql<{
          body_json: string;
        }>`SELECT body_json FROM memory_payloads WHERE space=${metadata.memorySpaceId} AND payload_ref=${metadata.resolution.judgmentRef}`,
      );
      if (!judgments[0]) return undefined;
      return yield* stored(
        "operation-codec",
        decodeOperation(
          {
            ...metadata,
            payload,
            resolutionPayload: yield* resolutionPayloadCodec.decode(judgments[0].body_json, strict),
          },
          strict,
        ),
      );
    }
    return yield* stored("operation-codec", decodeOperation({ ...metadata, payload }, strict));
  });
  const readWorkOperation = Effect.fn("MemoryStore.readWorkOperation")(function* (id: string) {
    const rows = yield* stored(
      "work-operation",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE id=${id} AND kind IN ('sync','resolve','revert_intent')`,
    );
    const work = (yield* workRows(rows))[0];
    return work && "protocolVersion" in work.metadata
      ? yield* operationFromMetadata(work.metadata)
      : undefined;
  });
  return {
    receipt,
    readAncestry,
    readPending,
    readItem,
    readResolutionSnapshot,
    readResolutionHeads,
    loadAggregate,
    readImportLineage,
    readSuppressions,
    logicalBytes,
    readOperation,
    operationFromMetadata,
    readWorkOperation,
  };
};

export type CoreReads = ReturnType<typeof makeCoreReads>;
