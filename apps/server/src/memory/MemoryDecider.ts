// @effect-diagnostics-next-line nodeBuiltinImport:off -- protocol digests are stable across runtimes.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import type {
  MemoryAdmissionContext,
  MemoryAggregate,
  MemoryAncestry,
  MemoryDecision,
} from "./MemoryStore.ts";
import { MemoryStoreConflict } from "./MemoryStore.ts";
import type { MemoryScanResult } from "./MemorySecretScanner.ts";

export const memoryOperationDigest = (operation: M.MemoryOperation) =>
  NodeCrypto.createHash("sha256").update(M.encodeMemoryOperation(operation)).digest("hex");
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));
function fail(code: M.MemoryFailureCode): never {
  throw new MemoryStoreConflict({ code });
}
const uuid = (text: string) => {
  const hex = NodeCrypto.createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Pure DAG decision. Approved replicas preserve the hub receipt and never repeat local CAS. */
export function decideMemoryOperation(
  current: MemoryAggregate,
  operation: M.MemoryOperation,
  admission: MemoryAdmissionContext,
  scan: MemoryScanResult | undefined,
  approval?: M.MemoryHubReceipt,
  ancestry?: MemoryAncestry,
  hubNow?: number,
): MemoryDecision {
  const digest = memoryOperationDigest(operation); // strict encoding rejects extra nested fields
  if (current.memoryId !== operation.memoryId || current.memorySpaceId !== operation.memorySpaceId)
    fail("identity_mismatch");
  const replica = admission.kind === "approvedReplica";
  if (
    replica &&
    (!approval ||
      approval.operationId !== operation.operationId ||
      approval.memoryId !== operation.memoryId ||
      approval.operationDigest !== digest ||
      approval.hubSequence === null)
  )
    fail("identity_mismatch");
  if (
    replica &&
    approval &&
    !M.validateMemoryResolutionApproval(
      operation.kind,
      operation.kind === "resolve" ? operation.resolution.resolutionId : null,
      approval,
    )
  )
    fail("unsupported_protocol");
  const base: MemoryDecision = {
    operation,
    operationDigest: digest,
    admission,
    receipt: approval ?? {
      operationId: operation.operationId,
      memoryId: operation.memoryId,
      outcome: operation.kind === "forget" ? "deleted" : "accepted",
      revisionId: operation.kind === "forget" ? null : operation.revision.revisionId,
      pendingSync: admission.kind === "localIntent",
    },
  };
  if (approval?.outcome === "rejected") return base;
  if (operation.kind !== "forget" && current.tombstone) {
    if (!replica) fail("forgotten");
    return base;
  }
  if (!replica && operation.kind !== "forget" && scan?.kind !== "allowed") fail("secret_detected");
  const identity = current.identity
    ? undefined
    : {
        memorySpaceId: operation.memorySpaceId,
        memoryId: operation.memoryId,
        scope: operation.kind === "forget" ? { kind: "user" as const } : operation.revision.scope,
        creatingEnvironmentId: operation.originEnvironmentId,
        createOperationId: operation.operationId,
        createdAtUtc:
          operation.kind === "forget"
            ? operation.tombstone.deletedAtUtc
            : operation.revision.createdAtUtc,
      };
  if (operation.kind === "forget") return { ...base, ...(identity ? { identity } : {}) };
  const r = operation.revision;
  if (operation.kind === "revert" && admission.kind === "localIntent")
    fail("unsupported_operation");
  if (operation.kind === "upsert" && current.heads.length > 1 && sameSet(current.heads, r.parents))
    fail("conflict_changed");
  if (current.identity && JSON.stringify(current.identity.scope) !== JSON.stringify(r.scope))
    fail("identity_mismatch");
  const revisions = new Map(
    current.revisions.map((pair) => [pair.revision.revisionId, pair.revision]),
  );
  for (const parent of r.parents) {
    const known = revisions.get(parent);
    if (known && (known.memoryId !== r.memoryId || known.memorySpaceId !== r.memorySpaceId))
      fail("identity_mismatch");
    const pending = [...(known?.parents ?? [])];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === r.revisionId) fail("identity_mismatch");
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(revisions.get(id)?.parents ?? []));
    }
  }
  if (operation.kind === "resolve") {
    for (let i = 0; i < operation.resolution.inputRevisionIds.length; i++) {
      const input = revisions.get(operation.resolution.inputRevisionIds[i]!);
      if (input && input.payloadRef !== operation.resolution.inputPayloadRefs[i])
        fail("identity_mismatch");
    }
  }
  const existing = revisions.get(r.revisionId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(r)) fail("identity_mismatch");
  if (r.parents.includes(r.revisionId)) fail("identity_mismatch");
  if (
    r.parents.length === 0 &&
    current.identity &&
    current.identity.createOperationId !== operation.operationId
  )
    fail("revision_changed");
  if (ancestry?.parents.some((parent) => parent.status === "crossMemory"))
    fail("identity_mismatch");
  const compacted = new Set(
    ancestry?.parents
      .filter((parent) => parent.status === "compacted")
      .map((parent) => parent.revisionId),
  );
  if (!replica && compacted.size) fail("base_compacted");
  const missing = r.parents.filter((id) => !revisions.has(id) && !compacted.has(id));
  if (
    admission.kind === "localIntent" &&
    !sameSet(current.heads, admission.localExpectedHeads ?? operation.expectedHeads) &&
    missing.length === 0
  )
    fail("revision_changed");
  if (operation.kind === "resolve" && !replica) {
    if (!sameSet(current.heads, operation.resolution.inputRevisionIds)) fail("conflict_changed");
    const lease = current.fence?.activeLease;
    if (!lease) fail("lease_required");
    if (
      lease.fencingToken !== operation.fencingToken ||
      current.fence?.highestFencingToken !== operation.fencingToken
    )
      fail("fenced");
    if (hubNow === undefined) fail("lease_required");
    if (Date.parse(lease.expiresAtHubTime) <= hubNow) fail("lease_expired");
    if (lease.conflictId !== operation.conflictId || !sameSet(lease.conflictHeadSet, current.heads))
      fail("conflict_changed");
  }
  if (operation.kind === "revert" && !replica) {
    const resolution = current.resolutions.find(
      (value) => value.resolutionId === operation.revertsResolutionId,
    );
    if (
      !resolution ||
      !sameSet(current.heads, [resolution.resultRevisionId]) ||
      !resolution.inputRevisionIds.includes(operation.restoredRevisionId)
    )
      fail("revision_changed");
    if (hubNow === undefined) fail("lease_required");
    if (hubNow >= Date.parse(resolution.revertDeadlineUtc)) fail("revert_expired");
    const original = current.revisions.find(
      (pair) => pair.revision.revisionId === operation.restoredRevisionId,
    )?.payload;
    if (!original || JSON.stringify(original) !== JSON.stringify(operation.payload))
      fail("revision_changed");
  }
  if (missing.length) {
    const item: M.MemoryItem = {
      memorySpaceId: r.memorySpaceId,
      memoryId: r.memoryId,
      scope: r.scope,
      status: "blocked",
      failureCode: "missing_parent",
      pendingSync: admission.kind === "localIntent",
      localAvailability: {
        exposure: "held",
        reasons: ["missing_parent"],
        cleanupPending: false,
        deferred: [
          {
            kind: "parent",
            state: "held",
            reason: "missing_parent",
            revisionId: r.revisionId,
            generation: current.generation + 1,
            sinceAtUtc: r.createdAtUtc,
          },
        ],
      },
    };
    return {
      ...base,
      ...(identity ? { identity } : {}),
      item,
      heads: current.heads,
      pending: { missingParents: missing, reason: "missing_parent" },
    };
  }
  revisions.set(r.revisionId, r);
  const ancestor = (parent: M.MemoryRevisionId, child: M.MemoryRevisionId): boolean => {
    const queue = [child];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const p of revisions.get(id)?.parents ?? []) {
        if (p === parent) return true;
        queue.push(p);
      }
    }
    return false;
  };
  // Include unrelated local frontier; prune ancestors even if the approved revision is historical.
  const candidates = [...new Set([...current.heads, r.revisionId])];
  const heads = candidates
    .filter((id) => !candidates.some((other) => id !== other && ancestor(id, other)))
    .sort();
  const availability: M.MemoryLocalAvailability = {
    exposure: "visible",
    reasons: [],
    deferred: [],
    cleanupPending: false,
  };
  if (heads.length >= 2) {
    const conflict: M.MemoryConflict = {
      memorySpaceId: r.memorySpaceId,
      memoryId: r.memoryId,
      conflictId: M.MemoryConflictId.make(
        uuid(`${r.memorySpaceId}:${r.memoryId}:${heads.join(":")}`),
      ),
      heads,
      status: "quarantined",
    };
    return {
      ...base,
      ...(identity ? { identity } : {}),
      heads,
      conflict,
      receipt: approval ?? { ...base.receipt, outcome: "conflicted" },
      item: {
        memorySpaceId: r.memorySpaceId,
        memoryId: r.memoryId,
        scope: r.scope,
        status: "quarantined",
        conflict,
        pendingSync: admission.kind === "localIntent",
        localAvailability: { ...availability, exposure: "held", reasons: ["conflicted"] },
      },
    };
  }
  const selected =
    heads[0] === r.revisionId
      ? { revision: r, payload: operation.payload }
      : current.revisions.find((pair) => pair.revision.revisionId === heads[0]);
  if (!selected?.payload) fail("missing_parent");
  return {
    ...base,
    ...(identity ? { identity } : {}),
    heads,
    item: {
      memorySpaceId: r.memorySpaceId,
      memoryId: r.memoryId,
      scope: r.scope,
      status: "active",
      revision: selected.revision,
      payload: selected.payload,
      pendingSync: admission.kind === "localIntent",
      localAvailability: availability,
    },
  };
}
