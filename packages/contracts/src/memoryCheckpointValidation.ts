import * as Schema from "effect/Schema";
import {
  MemoryHubCheckpointPage,
  memoryImportLineageRecordKey,
  type MemoryId,
  type MemoryOperationId,
} from "./memory.ts";
import { importScopeKey, same, sameSet } from "./memoryCodec.ts";

const checkpointDecode = Schema.decodeUnknownSync(MemoryHubCheckpointPage, {
  onExcessProperty: "error",
});
/**
 * Validate structural ledger links without stateful admission or quotas.
 * The server must separately verify report-key digests before installing the snapshot.
 */
export function validateMemoryCheckpointRecords(
  pages: readonly MemoryHubCheckpointPage[],
): boolean {
  const [first] = pages;
  if (!first) return false;
  try {
    pages.forEach((page) => checkpointDecode(page));
  } catch {
    return false;
  }
  if (
    !pages.every(
      (p, i) =>
        p.pageOrdinal === i &&
        p.memorySpaceId === first.memorySpaceId &&
        p.checkpointSequence === first.checkpointSequence &&
        p.retentionFloor === first.retentionFloor &&
        same(p.causalBoundary, first.causalBoundary) &&
        p.bootstrapComplete === (i === pages.length - 1),
    )
  )
    return false;
  const identities = pages.flatMap((p) => p.identities),
    fences = pages.flatMap((p) => p.fences),
    receipts = pages.flatMap((p) => p.compactReceipts),
    revisions = pages.flatMap((p) => p.revisions),
    resolutions = pages.flatMap((p) => p.resolutions),
    tombstones = pages.flatMap((p) => p.tombstones),
    suppressions = pages.flatMap((p) => p.suppressions),
    importLineage = pages.flatMap((p) => p.importLineage),
    conflicts = pages.flatMap((p) => p.conflicts),
    items = pages.flatMap((p) => p.items);
  const identitiesById = uniqueIndex(identities, (v) => v.memoryId);
  const fencesById = uniqueIndex(fences, (v) => v.memoryId);
  const receiptsByOperation = uniqueIndex(receipts, (v) => v.receipt.operationId);
  const revisionsById = uniqueIndex(revisions, (v) => v.revision.revisionId);
  const resolutionsById = uniqueIndex(resolutions, (v) => v.resolution.resolutionId);
  const tombstonesById = uniqueIndex(tombstones, (v) => v.memoryId);
  const conflictsById = uniqueIndex(conflicts, (v) => v.conflictId);
  const itemsById = uniqueIndex(items, (v) => v.memoryId);
  const lineageRows = uniqueIndex(importLineage, memoryImportLineageRecordKey);
  const suppressionRows = uniqueIndex(suppressions, (v) => JSON.stringify(v));
  // Rejected attempts may share a resolution id; only committed results own that key.
  const resolveReceiptsById = uniqueIndex(
    receipts.filter(
      (v) =>
        v.operationKind === "resolve" &&
        (v.receipt.outcome === "accepted" || v.receipt.outcome === "conflicted"),
    ),
    (v) => v.resolutionId,
  );
  if (
    !identitiesById ||
    !fencesById ||
    !receiptsByOperation ||
    !revisionsById ||
    !resolutionsById ||
    !tombstonesById ||
    !conflictsById ||
    !itemsById ||
    !suppressionRows ||
    !lineageRows ||
    !resolveReceiptsById
  )
    return false;
  const identity = (id: MemoryId) => identitiesById.get(id);
  const fence = (id: MemoryId) => fencesById.get(id);
  const receipt = (id: MemoryOperationId) => receiptsByOperation.get(id);
  const metadata = [
    ...identities,
    ...fences,
    ...receipts
      .filter((r) => r.receipt.outcome !== "rejected")
      .map((r) => ({ ...r, memoryId: r.receipt.memoryId })),
    ...revisions.map((r) => r.revision),
    ...resolutions.map((r) => r.resolution),
    ...tombstones,
    ...suppressions,
    ...importLineage,
    ...conflicts,
    ...items,
  ];
  if (
    !metadata.every(
      (v) =>
        v.memorySpaceId === first.memorySpaceId &&
        identity(v.memoryId) !== undefined &&
        fence(v.memoryId) !== undefined,
    )
  )
    return false;
  if (
    !importLineage.every((v) => {
      if (v.kind !== "content") return true;
      const owner = identity(v.memoryId);
      return (
        owner !== undefined &&
        (owner.scopeVersion !== undefined ||
          same(importScopeKey(v.content.scope), importScopeKey(owner.scope)))
      );
    })
  )
    return false;
  // Digest shape is enforced by the codec. WP2's server verifies report-key hashes
  // with Node crypto before WP3 installs a snapshot; contracts do not compute hashes.
  if (
    !receipts.every(
      (r) =>
        r.receipt.outcome === "rejected" ||
        r.operationKind !== "resolve" ||
        (fence(r.receipt.memoryId)?.highestFencingToken ?? -1) >= (r.fencingToken ?? 0),
    )
  )
    return false;
  if (
    !receipts.every(
      (r) =>
        r.memorySpaceId === first.memorySpaceId &&
        r.receipt.hubSequence !== null &&
        r.receipt.hubSequence <= first.checkpointSequence,
    )
  )
    return false;
  if (
    !identities.every((i) => {
      const r = receipt(i.createOperationId);
      return (
        r !== undefined &&
        r.receipt.memoryId === i.memoryId &&
        r.originEnvironmentId === i.creatingEnvironmentId &&
        (((r.receipt.outcome === "accepted" || r.receipt.outcome === "conflicted") &&
          r.operationKind === "upsert") ||
          (r.receipt.outcome === "deleted" &&
            r.operationKind === "forget" &&
            tombstonesById.get(i.memoryId)?.deleteOperationId === i.createOperationId))
      );
    })
  )
    return false;
  if (
    !revisions.every(({ revision: r }) => {
      const rec = receipt(r.operationId);
      return (
        same(r.scope, identity(r.memoryId)?.scope) &&
        rec !== undefined &&
        rec.receipt.memoryId === r.memoryId &&
        rec.revisionId === r.revisionId
      );
    })
  )
    return false;
  if (
    !items.every((i) =>
      i.status === "forgotten"
        ? same(tombstonesById.get(i.memoryId), i.tombstone)
        : same(i.scope, identity(i.memoryId)?.scope),
    )
  )
    return false;
  if (
    !tombstones.every((t) => {
      const r = receipt(t.deleteOperationId);
      return (
        r?.receipt.outcome === "deleted" &&
        r.receipt.memoryId === t.memoryId &&
        r.originEnvironmentId === t.deletingEnvironmentId &&
        fence(t.memoryId)?.activeLease === null
      );
    })
  )
    return false;
  if (
    !suppressions.every(
      (s) => tombstonesById.get(s.memoryId)?.deleteOperationId === s.deleteOperationId,
    )
  )
    return false;
  if (
    !resolutions.every(({ resolution: r }) => {
      const rec = resolveReceiptsById.get(r.resolutionId);
      const result = revisionsById.get(r.resultRevisionId)?.revision;
      return (
        rec !== undefined &&
        (rec.receipt.outcome === "accepted" || rec.receipt.outcome === "conflicted") &&
        rec.receipt.memoryId === r.memoryId &&
        rec.originEnvironmentId === r.resolvingEnvironmentId &&
        rec.reportGuard?.resolvingEnvironmentId === r.resolvingEnvironmentId &&
        rec.revisionId === r.resultRevisionId &&
        rec.fencingToken === r.fencingToken &&
        rec.receipt.resolutionApproval?.appliedAtUtc === r.appliedAtUtc &&
        rec.receipt.resolutionApproval?.revertDeadlineUtc === r.revertDeadlineUtc &&
        result !== undefined &&
        result.memoryId === r.memoryId &&
        result.operationId === rec.receipt.operationId &&
        result.provenance.environmentId === r.resolvingEnvironmentId &&
        sameSet(result.parents, r.inputRevisionIds) &&
        r.inputRevisionIds.every((id, i) => {
          const input = revisionsById.get(id)?.revision;
          return input?.memoryId === r.memoryId && input.payloadRef === r.inputPayloadRefs[i];
        }) &&
        (fence(r.memoryId)?.highestFencingToken ?? -1) >= r.fencingToken
      );
    })
  )
    return false;
  return fences.every((f) => {
    if (f.activeLease === null) return true;
    const conflict = conflictsById.get(f.activeLease.conflictId);
    return (
      conflict !== undefined &&
      conflict.memoryId === f.memoryId &&
      conflict.status !== "resolved" &&
      same(conflict.heads, f.activeLease.conflictHeadSet)
    );
  });
}

/** Index one ledger collection without silently overwriting duplicate keys. */
function uniqueIndex<T, K>(values: readonly T[], keyOf: (value: T) => K): Map<K, T> | undefined {
  const index = new Map<K, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (index.has(key)) return undefined;
    index.set(key, value);
  }
  return index;
}
