import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";
import { assert, describe, it } from "vite-plus/test";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
import { approvedReplica, hubAdmission, localIntent, type MemoryAggregate } from "./MemoryStore.ts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const env = M.EnvironmentId.make("fixture-owner");
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const time = "2026-10-14T00:00:00.000Z";
const selection: M.MemoryModelSelection = {
  instanceId: M.ProviderInstanceId.make("fixture"),
  model: "fixture-model",
};
const root = (
  n = 3,
  parents: readonly M.MemoryRevisionId[] = [],
): Extract<M.MemoryOperation, { kind: "upsert" }> => {
  const operationId = M.MemoryOperationId.make(id(n));
  const revisionId = M.MemoryRevisionId.make(id(n + 100));
  const operation = decodeOperation({
    protocolVersion: 1,
    operationId,
    memorySpaceId: space,
    memoryId: memory,
    originEnvironmentId: env,
    kind: "upsert",
    expectedHeads: [...parents].sort(),
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId,
      operationId,
      parents: [...parents].sort(),
      scope: { kind: "user" },
      payloadRef: revisionId,
      assertionKind: "inference",
      provenance: { environmentId: env },
      createdAtUtc: time,
    },
    payload: { text: `ordinary ${n}`, evidence: [], derivedFromMemoryRevisions: [] },
  });
  if (operation.kind !== "upsert") throw new Error("Fixture kind");
  return operation;
};
const empty = (): MemoryAggregate => ({
  memorySpaceId: space,
  memoryId: memory,
  item: undefined,
  heads: [],
  revisions: [],
  tombstone: undefined,
  conflicts: [],
  resolutions: [],
  identity: undefined,
  fence: undefined,
  pendingForget: undefined,
  generation: 0,
});
const state = (
  operations: readonly Extract<M.MemoryOperation, { kind: "upsert" }>[],
): MemoryAggregate => ({
  ...empty(),
  heads: operations.map((op) => op.revision.revisionId).sort(),
  revisions: operations.map((op) => ({ revision: op.revision, payload: op.payload })),
  identity: {
    memorySpaceId: space,
    memoryId: memory,
    scope: { kind: "user" },
    creatingEnvironmentId: env,
    createOperationId: operations[0]!.operationId,
    createdAtUtc: time,
  },
});
const allowed = { kind: "allowed" } as const;
const approval = (op: M.MemoryOperation): M.MemoryHubReceipt => ({
  operationId: op.operationId,
  memoryId: op.memoryId,
  operationDigest: memoryOperationDigest(op),
  hubSequence: 1,
  outcome: op.kind === "forget" ? "deleted" : "accepted",
  ...(op.kind === "resolve"
    ? {
        resolutionApproval: {
          resolutionId: op.resolution.resolutionId,
          appliedAtUtc: M.MemoryUtcTimestamp.make(time),
          revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-11-13T00:00:00.000Z"),
        },
      }
    : {}),
});
const forget = (): Extract<M.MemoryOperation, { kind: "forget" }> => ({
  protocolVersion: 1,
  kind: "forget",
  memorySpaceId: space,
  memoryId: memory,
  operationId: M.MemoryOperationId.make(id(70)),
  originEnvironmentId: env,
  expectedHeads: [],
  tombstone: {
    memorySpaceId: space,
    memoryId: memory,
    deleteOperationId: M.MemoryOperationId.make(id(70)),
    deletingEnvironmentId: env,
    deletedAtUtc: time,
    suppressedSourceKeys: [],
    suppressedContent: [],
    sourceExclusions: [],
  },
});

describe("MemoryDecider", () => {
  it("creates a root only for a never-seen ID", () => {
    assert.strictEqual(
      decideMemoryOperation(empty(), root(), localIntent, allowed).item?.status,
      "active",
    );
    assert.throws(() => decideMemoryOperation(state([root()]), root(4), localIntent, allowed));
    assert.throws(() =>
      decideMemoryOperation(
        { ...state([root()]), tombstone: forget().tombstone },
        root(4),
        localIntent,
        allowed,
      ),
    );
  });
  it("parks an edit with missing parents", () => {
    const op = root(4, [M.MemoryRevisionId.make(id(99))]);
    const decision = decideMemoryOperation(empty(), op, approvedReplica, undefined, approval(op));
    assert.deepStrictEqual(decision.pending?.missingParents, op.expectedHeads);
    assert.strictEqual(decision.item?.status, "blocked");
    assert.notInclude(JSON.stringify(decision.item), op.payload.text);
    assert.deepStrictEqual(decision.heads, []);
  });
  it("rejects cross-memory parents and cycles", () => {
    const first = root();
    const next = root(4, [first.revision.revisionId]);
    const current = state([first]);
    assert.throws(() =>
      decideMemoryOperation(
        {
          ...current,
          revisions: [
            {
              revision: { ...first.revision, memoryId: M.MemoryId.make(id(90)) },
              payload: first.payload,
            },
          ],
        },
        next,
        localIntent,
        allowed,
      ),
    );
    assert.throws(() =>
      decideMemoryOperation(
        {
          ...current,
          revisions: [
            {
              revision: { ...first.revision, parents: [next.revision.revisionId] },
              payload: first.payload,
            },
          ],
        },
        next,
        localIntent,
        allowed,
      ),
    );
  });
  it("keeps an ordinary edit quarantined", () => {
    const first = root();
    const other = root(4);
    const next = root(5, [first.revision.revisionId]);
    const decision = decideMemoryOperation(
      state([first, other]),
      next,
      approvedReplica,
      allowed,
      approval(next),
    );
    assert.strictEqual(decision.item?.status, "quarantined");
    assert.deepStrictEqual(
      decision.heads,
      [other.revision.revisionId, next.revision.revisionId].sort(),
    );
    assert.throws(() =>
      decideMemoryOperation(
        state([first, other]),
        root(6, [first.revision.revisionId, other.revision.revisionId]),
        localIntent,
        allowed,
      ),
    );
  });
  it("uses all heads for resolution", () => {
    const first = root();
    const other = root(4);
    const third = root(5);
    const current = state([first, other, third]);
    const proposed = root(6, [first.revision.revisionId, other.revision.revisionId]);
    const resolution: M.MemoryResolution = {
      resolutionId: M.MemoryResolutionId.make(id(90)),
      memorySpaceId: space,
      memoryId: memory,
      inputRevisionIds: proposed.expectedHeads,
      inputPayloadRefs: proposed.expectedHeads,
      judgmentRef: M.MemoryResolutionId.make(id(90)),
      requestedModelSelection: selection,
      effectiveProvider: M.ProviderDriverKind.make("codex"),
      effectiveModel: selection.model,
      resolvingEnvironmentId: env,
      fencingToken: 1,
      resultRevisionId: proposed.revision.revisionId,
      appliedAtUtc: time,
      revertDeadlineUtc: time,
    };
    const op: M.MemoryOperation = {
      ...proposed,
      kind: "resolve",
      resolution,
      resolutionPayload: { resolutionId: resolution.resolutionId, judgment: "ordinary" },
      conflictId: M.MemoryConflictId.make(id(91)),
      fencingToken: 1,
    };
    assert.throws(() => decideMemoryOperation(current, op, hubAdmission, allowed));
    const replica = decideMemoryOperation(current, op, approvedReplica, undefined, approval(op));
    assert.strictEqual(replica.item?.status, "quarantined");
    assert.deepStrictEqual(
      replica.heads,
      [third.revision.revisionId, proposed.revision.revisionId].sort(),
    );
  });
  it("stale forget beats every operation kind", () => {
    const first = root();
    const op = root(4, [first.revision.revisionId]);
    const current = { ...state([first]), tombstone: forget().tombstone };
    assert.throws(() => decideMemoryOperation(current, op, localIntent, allowed));
    const decision = decideMemoryOperation(current, op, approvedReplica, undefined, approval(op));
    assert.isUndefined(decision.item);
    assert.deepStrictEqual(decision.receipt, approval(op));
    assert.strictEqual(
      decideMemoryOperation(current, forget(), localIntent, undefined).receipt.outcome,
      "deleted",
    );
  });
  it("approved revert restores the explicitly selected original", () => {
    const first = root();
    const other = root(4);
    const result = root(5, [first.revision.revisionId, other.revision.revisionId]);
    const current = { ...state([first, other, result]), heads: [result.revision.revisionId] };
    const next = root(6, [result.revision.revisionId]);
    const op: M.MemoryOperation = {
      ...next,
      kind: "revert",
      payload: other.payload,
      revertsResolutionId: M.MemoryResolutionId.make(id(90)),
      restoredRevisionId: other.revision.revisionId,
    };
    assert.throws(() => decideMemoryOperation(current, op, localIntent, allowed));
    const decision = decideMemoryOperation(current, op, approvedReplica, undefined, approval(op));
    assert.isTrue(
      decision.item?.status === "active" && decision.item.payload.text === other.payload.text,
    );
    assert.deepStrictEqual(decision.heads, [next.revision.revisionId]);
    assert.strictEqual(current.revisions.length, 3);
  });
  it("rejects forged approval and unknown content fields", () => {
    const op = root();
    assert.throws(() =>
      decideMemoryOperation(empty(), op, approvedReplica, undefined, {
        ...approval(op),
        operationDigest: "a".repeat(64),
      }),
    );
    assert.throws(() =>
      decideMemoryOperation(
        empty(),
        Object.assign({}, op, { payload: { ...op.payload, secret: "sentinel" } }),
        localIntent,
        allowed,
      ),
    );
  });
  it("approved descendant preserves its unrelated frontier", () => {
    const first = root();
    const descendant = root(4, [first.revision.revisionId]);
    const unrelated = root(5);
    const op = root(6, [first.revision.revisionId]);
    const current = {
      ...state([first, descendant, unrelated]),
      heads: [descendant.revision.revisionId, unrelated.revision.revisionId].sort(),
    };
    const decision = decideMemoryOperation(current, op, approvedReplica, undefined, approval(op));
    assert.deepStrictEqual(decision.heads, [...current.heads, op.revision.revisionId].sort());
  });
});

describe("published ancestry boundary", () => {
  const parent = M.MemoryRevisionId.make(id(200));
  const op = root(4, [parent]);
  const boundary = { checkpointSequence: 10, boundaryId: "fixture" };
  it("links an approved edit to a proven compacted parent", () => {
    const decision = decideMemoryOperation(empty(), op, approvedReplica, undefined, approval(op), {
      causalBoundary: boundary,
      retentionFloor: 10,
      parents: [{ revisionId: parent, status: "compacted", boundary }],
    });
    assert.isUndefined(decision.pending);
    assert.strictEqual(decision.item?.status, "active");
  });
  it("does not infer compaction of an unknown parent from a boundary", () => {
    const decision = decideMemoryOperation(empty(), op, approvedReplica, undefined, approval(op), {
      causalBoundary: boundary,
      retentionFloor: 10,
      parents: [{ revisionId: parent, status: "missing" }],
    });
    assert.deepStrictEqual(decision.pending?.missingParents, [parent]);
  });
  it("requires local writers to resync a compacted base", () => {
    assert.throws(() =>
      decideMemoryOperation(empty(), op, localIntent, { kind: "allowed" }, undefined, {
        causalBoundary: boundary,
        retentionFloor: 10,
        parents: [{ revisionId: parent, status: "compacted", boundary }],
      }),
    );
  });
  it("rejects a known foreign parent before parking it", () => {
    assert.throws(() =>
      decideMemoryOperation(empty(), op, approvedReplica, undefined, approval(op), {
        causalBoundary: boundary,
        retentionFloor: 10,
        parents: [
          { revisionId: parent, status: "crossMemory", memoryId: M.MemoryId.make(id(201)) },
        ],
      }),
    );
  });
});

it("admits hub siblings from a known parent while local CAS rejects the stale edit", () => {
  const parent = root();
  const first = root(4, [parent.revision.revisionId]);
  const second = root(5, [parent.revision.revisionId]);
  const current = { ...state([parent, first]), heads: [first.revision.revisionId] };
  assert.throws(() => decideMemoryOperation(current, second, localIntent, allowed));
  const result = decideMemoryOperation(current, second, hubAdmission, allowed);
  assert.strictEqual(result.item?.status, "quarantined");
  assert.deepStrictEqual(
    result.heads,
    [first.revision.revisionId, second.revision.revisionId].sort(),
  );
});
