import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";

export const checkpointKeys = [
  "items",
  "revisions",
  "tombstones",
  "conflicts",
  "resolutions",
  "compactReceipts",
  "identities",
  "fences",
  "suppressions",
  "importLineage",
] as const;
export type CheckpointInventory = {
  -readonly [K in (typeof checkpointKeys)[number]]: M.MemoryHubCheckpointPage[K][number][];
};
export const emptyCheckpointInventory = (): CheckpointInventory => ({
  items: [],
  revisions: [],
  tombstones: [],
  conflicts: [],
  resolutions: [],
  compactReceipts: [],
  identities: [],
  fences: [],
  suppressions: [],
  importLineage: [],
});
const strict = { onExcessProperty: "error" } as const;
const jsonDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (json: string) => decode(json, strict);
};
const valueDecoder = <S extends Schema.Constraint>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: unknown) => decode(value, strict);
};
const decodeIdentity = jsonDecoder(M.MemoryIdentityRecord);
const decodeFence = jsonDecoder(M.MemoryFenceRecord);
const decodeLineage = jsonDecoder(M.MemoryImportLineageRecord);
const decodeProjection = jsonDecoder(Schema.Record(Schema.String, Schema.Unknown));
const decodePayload = jsonDecoder(M.MemoryPayload);
const decodeHeads = jsonDecoder(Schema.Array(M.MemoryRevisionId));
const decodeSuppression = jsonDecoder(M.MemorySuppressionRecord);
const decodeResolution = jsonDecoder(M.MemoryResolution);
const decodeJudgment = jsonDecoder(M.MemoryResolutionPayload);
const decodeScope = jsonDecoder(M.MemoryScope);
const decodeProvenance = jsonDecoder(M.MemoryProvenance);
const decodeCompact = jsonDecoder(M.MemoryCompactReceipt);
const decodeItem = valueDecoder(M.MemoryItem);
const decodeTombstone = valueDecoder(M.MemoryTombstone);
const decodeRevision = valueDecoder(M.MemoryRevision);
const decodeConflict = valueDecoder(M.MemoryConflict);
const validatePage = Schema.decodeUnknownEffect(M.MemoryHubCheckpointPage);
const timestamp = (n: number) => DateTime.formatIso(DateTime.makeUnsafe(n));

/** These are JSON objects in the page, never JSON strings containing encoded JSON. */
export const encodeCheckpointRecord = (
  record: CheckpointInventory[(typeof checkpointKeys)[number]][number],
) => JSON.stringify(record);
export const checkpointInventorySize = (inventory: CheckpointInventory) => {
  let bytes = 0;
  let rows = 0;
  for (const key of checkpointKeys)
    for (const record of inventory[key]) {
      bytes += new TextEncoder().encode(encodeCheckpointRecord(record)).length;
      rows++;
    }
  return { bytes, rows };
};

type RevisionRow = {
  revision_id: string;
  operation_id: string;
  parents_json: string;
  scope_json: string;
  assertion_kind: string;
  provenance_json: string;
  payload_ref: string | null;
  created_at: number;
};
const revisionRecord = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  id: M.MemoryId,
  r: RevisionRow,
  body: string | null,
) {
  return {
    revision: yield* decodeRevision({
      memorySpaceId: space,
      memoryId: id,
      revisionId: r.revision_id,
      operationId: r.operation_id,
      parents: yield* decodeHeads(r.parents_json),
      scope: yield* decodeScope(r.scope_json),
      assertionKind: r.assertion_kind,
      provenance: yield* decodeProvenance(r.provenance_json),
      payloadRef: r.payload_ref ?? r.revision_id,
      createdAtUtc: timestamp(r.created_at),
    }),
    payload: body ? yield* decodePayload(body) : null,
  };
});

/**
 * Admission size of this memory's body-free revision records outside `selected`.
 * Those records never change, so each row is decoded, validated and measured once
 * into `memory_revisions.checkpoint_bytes`; later writes only sum the cached sizes.
 * Equals what `selectCheckpointMemory` without `publishedLineage` would add for them.
 */
export const measureCheckpointRevisionHistory = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  id: M.MemoryId,
  selected: ReadonlyArray<M.MemoryRevisionId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const unmeasured =
    yield* sql<RevisionRow>`SELECT revision_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at FROM memory_revisions WHERE space=${space} AND memory_id=${id} AND checkpoint_bytes IS NULL`;
  for (const r of unmeasured) {
    const record = yield* revisionRecord(space, id, r, null);
    yield* validateCheckpointInventory(space, {
      ...emptyCheckpointInventory(),
      revisions: [record],
    });
    yield* sql`UPDATE memory_revisions SET checkpoint_bytes=${checkpointInventorySize({ ...emptyCheckpointInventory(), revisions: [record] }).bytes} WHERE space=${space} AND revision_id=${r.revision_id}`;
  }
  const outside = selected.length ? sql`revision_id NOT IN ${sql.in(selected)}` : sql`1=1`;
  const [total] = yield* sql<{
    rows: number;
    bytes: number;
  }>`SELECT count(*) AS rows,coalesce(sum(checkpoint_bytes),0) AS bytes FROM memory_revisions WHERE space=${space} AND memory_id=${id} AND ${outside}`;
  return { bytes: total?.bytes ?? 0, rows: total?.rows ?? 0 };
});

/** Shared by admission, migration and publication. Only this memory's selected pairs are loaded. */
export const selectCheckpointMemory = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  id: M.MemoryId,
  now: number,
  includeIndependent = true,
  publishedLineage?: ReadonlySet<M.MemoryRevisionId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const all = emptyCheckpointInventory();
  const ledgers = yield* sql<{
    identity_json: string;
    fence_json: string;
  }>`SELECT identity_json,fence_json FROM memory_identity_ledger WHERE space=${space} AND memory_id=${id}`;
  if (!ledgers[0]) return all;
  all.identities.push(yield* decodeIdentity(ledgers[0].identity_json));
  all.fences.push(yield* decodeFence(ledgers[0].fence_json));
  if (includeIndependent) {
    const independent = yield* selectCheckpointIndependent(space, id);
    all.importLineage = independent.importLineage;
    all.suppressions = independent.suppressions;
  }
  const items = yield* sql<{
    item_json: string;
    heads_json: string;
    body_json: string | null;
  }>`SELECT i.item_json,i.heads_json,p.body_json FROM memory_items i LEFT JOIN memory_payloads p ON p.space=i.space AND p.payload_ref=i.payload_ref WHERE i.space=${space} AND i.memory_id=${id}`;
  const row = items[0];
  let heads: readonly M.MemoryRevisionId[] = [];
  if (row) {
    const projection = yield* decodeProjection(row.item_json);
    const unsent =
      yield* sql`SELECT 1 FROM memory_outbox WHERE space=${space} AND memory_id=${id} AND kind IN ('sync','revert_intent') AND status IN ('pending','retry','running') LIMIT 1`;
    const item = yield* decodeItem(
      projection.status === "active"
        ? row.body_json
          ? {
              ...projection,
              payload: yield* decodePayload(row.body_json),
              pendingSync: unsent.length > 0,
            }
          : {
              memorySpaceId: space,
              memoryId: id,
              status: "blocked",
              scope: projection.scope,
              pendingSync: unsent.length > 0,
              failureCode: "source_invalidated",
              localAvailability: {
                exposure: "held",
                reasons: ["dependency_invalidated"],
                deferred: [],
                cleanupPending: true,
              },
            }
        : { ...projection, pendingSync: unsent.length > 0 },
    );
    all.items.push(
      item.status === "forgotten"
        ? {
            ...item,
            tombstone: {
              ...item.tombstone,
              suppressedSourceKeys: [],
              suppressedContent: [],
              sourceExclusions: [],
            },
          }
        : item,
    );
    heads = yield* decodeHeads(row.heads_json);
  }
  const tombstones = yield* sql<{
    delete_operation_id: string;
    deleting_environment_id: string;
    deleted_at: number;
  }>`SELECT * FROM memory_tombstones WHERE space=${space} AND memory_id=${id}`;
  const t = tombstones[0];
  if (t) {
    all.tombstones.push(
      yield* decodeTombstone({
        memorySpaceId: space,
        memoryId: id,
        deleteOperationId: t.delete_operation_id,
        deletingEnvironmentId: t.deleting_environment_id,
        deletedAtUtc: timestamp(t.deleted_at),
        suppressedSourceKeys: [],
        suppressedContent: [],
        sourceExclusions: [],
      }),
    );
    return all;
  }
  const resolutions = yield* sql<{
    resolution_json: string;
    body_json: string | null;
  }>`SELECT r.resolution_json,p.body_json FROM memory_resolutions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.judgment_payload_ref WHERE r.space=${space} AND r.memory_id=${id} AND r.revert_deadline>${now} ORDER BY r.resolution_id`;
  for (const r of resolutions)
    all.resolutions.push({
      resolution: yield* decodeResolution(r.resolution_json),
      payload: r.body_json ? yield* decodeJudgment(r.body_json) : null,
    });
  const needed = new Set([
    ...heads,
    ...all.resolutions.flatMap(({ resolution: r }) => [...r.inputRevisionIds, r.resultRevisionId]),
  ]);
  // Admission reserves every retained body-free identity as an upper bound.
  // Publication passes its dependency set, so history does not widen its SQL read.
  // Both use the same literal encoder; narrowing publication cannot exceed U_next.
  const selected =
    publishedLineage === undefined ? undefined : [...new Set([...needed, ...publishedLineage])];
  const selection =
    selected === undefined
      ? sql`1=1`
      : selected.length
        ? sql`r.revision_id IN ${sql.in(selected)}`
        : sql`0=1`;
  // A shared payload is deliberately joined once per selected revision. Columns
  // are named: a statement cached before migration 090 added checkpoint_bytes
  // would map `r.*` onto stale column names and read body_json as NULL.
  const revisions = yield* sql<
    RevisionRow & { body_json: string | null }
  >`SELECT r.space,r.revision_id,r.memory_id,r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,r.payload_ref,r.created_at,p.body_json FROM memory_revisions r LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${space} AND r.memory_id=${id} AND ${selection} ORDER BY r.revision_id`;
  for (const r of revisions)
    all.revisions.push(
      yield* revisionRecord(
        space,
        id,
        r,
        needed.has(M.MemoryRevisionId.make(r.revision_id)) ? r.body_json : null,
      ),
    );
  const conflicts = yield* sql<{
    conflict_id: string;
    heads_json: string;
    status: string;
    failure_code: string | null;
  }>`SELECT * FROM memory_conflicts WHERE space=${space} AND memory_id=${id} AND status!='resolved' ORDER BY conflict_id`;
  for (const c of conflicts)
    all.conflicts.push(
      yield* decodeConflict({
        conflictId: c.conflict_id,
        memorySpaceId: space,
        memoryId: id,
        heads: yield* decodeHeads(c.heads_json),
        status: c.status,
        ...(c.failure_code ? { failureCode: c.failure_code } : {}),
      }),
    );
  return all;
});

export const selectCheckpointReceipt = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  operationId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    compact_json: string;
  }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${operationId}`;
  const all = emptyCheckpointInventory();
  if (rows[0]) all.compactReceipts.push(yield* decodeCompact(rows[0].compact_json));
  return all;
});

/** Validation and literal object insertion keep escaping identical to record accounting. */
export const encodeCheckpointPage = (page: M.MemoryHubCheckpointPage) =>
  validatePage(page, strict).pipe(
    Effect.map(
      () =>
        `{${Object.entries(page)
          .map(
            ([key, value]) =>
              `${JSON.stringify(key)}:${checkpointKeys.includes(key as (typeof checkpointKeys)[number]) ? `[${(value as CheckpointInventory[(typeof checkpointKeys)[number]]).map(encodeCheckpointRecord).join(",")}]` : JSON.stringify(value)}`,
          )
          .join(",")}}`,
    ),
  );

const validatePull = Schema.decodeUnknownEffect(M.MemoryHubPullResult);
/** A numeric/continuation change must not make an admitted single record unpageable. */
export const validateCheckpointInventory = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  inventory: CheckpointInventory,
) {
  for (const key of checkpointKeys)
    for (const record of inventory[key]) {
      yield* validatePull(
        {
          highWatermark: Number.MAX_SAFE_INTEGER,
          throughSequence: Number.MAX_SAFE_INTEGER,
          hasMore: true,
          entries: [],
          checkpoint: {
            memorySpaceId: space,
            checkpointSequence: Number.MAX_SAFE_INTEGER,
            retentionFloor: Number.MAX_SAFE_INTEGER,
            causalBoundary: {
              checkpointSequence: Number.MAX_SAFE_INTEGER,
              boundaryId: "f".repeat(64),
            },
            pageOrdinal: Number.MAX_SAFE_INTEGER,
            ...emptyCheckpointInventory(),
            [key]: [record],
            nextCursor: "f".repeat(64),
            bootstrapComplete: false,
          },
        },
        strict,
      );
    }
});

/** Bulk publication and keyed admission share these exact independent-record predicates.
 * Keyed refresh uses the row's transient SQLite address; cached sizes live ON the
 * row, so vacuum/rowid reuse cannot associate a durable cache with another record.
 */
export const selectCheckpointIndependent = Effect.fnUntraced(function* (
  space: M.MemorySpaceId,
  id: M.MemoryId | undefined,
  selection?: { kind: "l" | "s"; rowid: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const all = emptyCheckpointInventory();
  const owner = id === undefined ? sql`1=1` : sql`memory_id=${id}`;
  if (!selection || selection.kind === "l") {
    const match = selection ? sql`l.rowid=${selection.rowid}` : sql`1=1`;
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM memory_import_lineage l WHERE space=${space} AND ${owner} AND ${match} AND EXISTS(SELECT 1 FROM memory_identity_ledger i WHERE i.space=l.space AND i.memory_id=l.memory_id) ORDER BY kind,key`;
    for (const row of rows) all.importLineage.push(yield* decodeLineage(row.record_json));
  }
  if (!selection || selection.kind === "s") {
    const match = selection ? sql`k.rowid=${selection.rowid}` : sql`1=1`;
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM memory_import_keys k WHERE space=${space} AND ${owner} AND key_kind IN ('sourceKey','content','sourceExclusion') AND ${match} AND EXISTS(SELECT 1 FROM memory_identity_ledger i WHERE i.space=k.space AND i.memory_id=k.memory_id) AND EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=k.space AND t.memory_id=k.memory_id) ORDER BY key_kind,key`;
    for (const row of rows) all.suppressions.push(yield* decodeSuppression(row.record_json));
  }
  return all;
});
