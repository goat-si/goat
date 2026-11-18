import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./MemoryStore.ts";

const strict = { onExcessProperty: "error" } as const;
const encodeHeads = Schema.encodeSync(Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)));
const decode = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.mapError(() => new Store.MemoryStoreConflict({ code: "invalid_output" })));
const decodeDependencyEdges = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(M.MemoryRevisionId)),
);
export const closureCap = Effect.fn("MemoryService.closureCap")(function* (space: M.MemorySpaceId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ derived_cap: number }>`
    SELECT derived_cap FROM memory_space_features WHERE space=${space}`.pipe(
    Effect.mapError((cause) => new Store.MemoryStorageError({ stage: "derived-cap", cause })),
  );
  return row?.derived_cap === M.MEMORY_DERIVED_REVISIONS_MAX
    ? M.MEMORY_DERIVED_REVISIONS_MAX
    : M.MEMORY_DERIVED_REVISIONS_MAX_V1;
});

export const validateCheckpointClosureCapacity = Effect.fn(
  "MemorySyncService.validateCheckpointClosureCapacity",
)(function* (page: M.MemoryHubCheckpointPage) {
  const cap = yield* closureCap(page.memorySpaceId);
  for (const entry of [...page.items, ...page.revisions])
    if ("payload" in entry && entry.payload)
      yield* requireClosureCapacity(entry.payload.derivedFromMemoryRevisions.length, cap);
});

export const relatedExposureCap = (space: M.MemorySpaceId) =>
  closureCap(space).pipe(Effect.map((cap) => (cap === M.MEMORY_DERIVED_REVISIONS_MAX ? 750 : 80)));

export const requireClosureCapacity = (count: number, limit: number) =>
  count > limit
    ? Effect.fail(
        new Store.MemoryCapacityError({ dimension: "dependencies", current: count, limit }),
      )
    : Effect.void;

/** Expand direct edges at authoritative writes. Internally captured closed sets may
 * outlive their bodies; they still require canonical live owners and all available edges. */
export const normalizeMemoryDependencies = Effect.fn("MemoryService.normalizeMemoryDependencies")(
  function* (
    space: M.MemorySpaceId,
    payload: M.MemoryPayload,
    allowPruned = false,
    resolutionHeads: ReadonlyArray<M.MemoryRevisionId> = [],
    resolvingMemoryId?: M.MemoryId,
  ) {
    const sql = yield* SqlClient.SqlClient;
    const limit = yield* closureCap(space);
    const revisions = new Set(payload.derivedFromMemoryRevisions);
    yield* requireClosureCapacity(revisions.size, limit);
    const allowedHeads = encodeHeads(resolutionHeads);
    for (const revision of revisions) {
      // Only authoritative resolution inputs may use this memory's own history
      // while its current frontier is quarantined. Foreign owners still need visibility.
      const rows = yield* sql<{ dependencies_json: string | null }>`
        SELECT p.dependencies_json FROM memory_revisions r
        JOIN memory_items i ON i.space=r.space AND i.memory_id=r.memory_id
        LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref AND p.memory_id=r.memory_id
        WHERE r.space=${space} AND r.revision_id=${revision}
        AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending q WHERE q.space=r.space AND q.operation_id=r.operation_id AND q.record_kind='operation')
        AND (i.status='active' AND json_extract(i.availability_json,'$.exposure')='visible'
          OR r.memory_id=${resolvingMemoryId ?? null} AND r.revision_id IN (SELECT value FROM json_each(${allowedHeads})))
        AND i.status NOT IN ('forgotten','blocked')
        AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=r.space AND f.memory_id=r.memory_id)
      `.pipe(
        Effect.mapError(
          (cause) => new Store.MemoryStorageError({ stage: "memory-dependencies", cause }),
        ),
      );
      if (!rows[0] || (rows[0].dependencies_json === null && !allowPruned))
        return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
      if (rows[0].dependencies_json !== null) {
        const edges = yield* decode(decodeDependencyEdges(rows[0].dependencies_json, strict));
        for (const edge of edges) revisions.add(edge);
        yield* requireClosureCapacity(revisions.size, limit);
      }
    }
    return { ...payload, derivedFromMemoryRevisions: [...revisions] };
  },
);
/** Consumers of a previously admitted closed set verify every still-available edge. */
export const validateSummaryDependencies = Effect.fn("MemoryService.validateSummaryDependencies")(
  function* (
    space: M.MemorySpaceId,
    payload: M.MemoryPayload,
    resolution?: {
      readonly memoryId: M.MemoryId;
      readonly revisions: ReadonlyArray<M.MemoryRevisionId>;
    },
  ) {
    const normalized = yield* normalizeMemoryDependencies(
      space,
      payload,
      true,
      resolution?.revisions ?? [],
      resolution?.memoryId,
    );
    if (
      normalized.derivedFromMemoryRevisions.length !==
      new Set(payload.derivedFromMemoryRevisions).size
    )
      return yield* new Store.MemoryStoreConflict({ code: "source_invalidated" });
  },
);
