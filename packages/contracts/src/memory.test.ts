import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as M from "./index.ts";
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-14T00:00:00.000Z";
const thread = { environmentId: "env", threadId: "thread" };
const watermark = { fromEventId: "e1", toEventId: "e2", throughSequence: 2 };
const selection = {
  instanceId: "codex",
  model: "alias",
  options: [
    { id: "effort", value: "high" },
    { id: "flag", value: false },
  ],
};
const payload = {
  text: "Synthetic memory",
  evidence: [{ origin: "user", messageIds: [] }],
  derivedFromMemoryRevisions: [],
};
const revision = {
  memorySpaceId: id(),
  memoryId: id(2),
  revisionId: id(3),
  operationId: id(4),
  parents: [],
  scope: { kind: "user" },
  payloadRef: id(3),
  assertionKind: "fact",
  provenance: { environmentId: "env" },
  createdAtUtc: now,
};
const tombstone = {
  memorySpaceId: id(),
  memoryId: id(2),
  deleteOperationId: id(4),
  deletingEnvironmentId: "env",
  deletedAtUtc: now,
  suppressedSourceKeys: [],
  suppressedContent: [],
  sourceExclusions: [],
};
const operation = {
  protocolVersion: 1,
  operationId: id(4),
  memorySpaceId: id(),
  originEnvironmentId: "env",
  memoryId: id(2),
  expectedHeads: [],
  kind: "upsert",
  revision,
  payload,
};
function decode<S extends Schema.Top>(schema: S, value: unknown): S["Type"] {
  return Schema.decodeUnknownSync(schema as S & Schema.ConstraintDecoder<unknown>)(value);
}
function round<S extends Schema.Top>(schema: S, value: unknown) {
  const typed = decode(schema, value);
  const json = Schema.encodeSync(
    Schema.fromJsonString(schema as S & Schema.ConstraintEncoder<unknown>),
  )(typed);
  expect(decode(Schema.fromJsonString(schema), json)).toEqual(typed);
  return typed;
}
function rejects<S extends Schema.Top>(schema: S, value: unknown) {
  expect(() => decode(schema, value)).toThrow();
}
describe("memory canonical contracts", () => {
  it("round-trips all eight memory ids and rejects malformed UUIDs", () => {
    for (const schema of [
      M.MemoryId,
      M.MemorySpaceId,
      M.MemoryRevisionId,
      M.MemoryOperationId,
      M.MemoryConflictId,
      M.MemoryResolutionId,
      M.MemoryImportSourceId,
      M.MemorySourceReadRequestId,
    ]) {
      round(schema, id());
      rejects(schema, "not-a-uuid");
      rejects(schema, id().toUpperCase().replace("4000", "0000"));
    }
  });
  it("round-trips user project and thread scopes", () => {
    for (const scope of [
      { kind: "user" },
      { kind: "project", projectKey: { kind: "repository", groupingKey: "repo" } },
      { kind: "thread", thread, projectKey: { kind: "explicit", sharedProjectId: "shared" } },
    ])
      round(M.MemoryScope, scope);
  });
  it("rejects malformed scope discriminants and missing locators", () => {
    rejects(M.MemoryScope, { kind: "unknown" });
    rejects(M.MemoryScope, { kind: "project" });
    rejects(M.MemoryScope, { kind: "thread" });
  });
  it("round-trips fact and inference provenance with source watermarks", () => {
    for (const assertionKind of ["fact", "inference"])
      round(M.MemoryOperation, {
        ...operation,
        revision: {
          ...revision,
          assertionKind,
          provenance: { environmentId: "env", sourceThread: thread, sourceWatermark: watermark },
        },
      });
  });
  it("rejects fact without non-model evidence", () => {
    rejects(M.MemoryOperation, {
      ...operation,
      payload: { ...payload, evidence: [{ origin: "model", messageIds: [] }] },
    });
    round(M.MemoryOperation, {
      ...operation,
      revision: { ...revision, assertionKind: "inference" },
      payload: { ...payload, evidence: [{ origin: "model", messageIds: [] }] },
    });
  });
  it("rejects legacy and malformed memory model options", () => {
    for (const options of [
      [{ id: "x", value: 1 }],
      [{ id: "x", value: null }],
      [{ id: "x", value: {} }],
      [{ id: "x", value: [] }],
      [{ id: "", value: true }],
      [{ id: "x", value: "" }],
      [
        { id: "x", value: true },
        { id: "x", value: false },
      ],
      [{ id: "x", value: true, extra: true }],
      [{ id: " x", value: true }],
      [{ id: "x", value: " padded " }],
    ]) {
      const raw = { ...selection, options };
      rejects(M.MemoryModelSelection, raw);
      expect(() => M.MemoryModelSelection.make(raw as never)).toThrow();
      expect(() => Schema.encodeSync(M.MemoryModelSelection)(raw as never)).toThrow();
    }
    for (const raw of [
      { provider: "codex", model: "alias" },
      { ...selection, instanceId: " codex" },
      { ...selection, model: "alias " },
    ])
      rejects(M.MemoryModelSelection, raw);
  });
  it("preserves canonical memory model options round-trip", () => {
    round(M.MemoryModelSelection, selection);
    round(M.MemoryModelSelection, { instanceId: "codex", model: "alias" });
    round(M.MemoryModelSelection, { ...selection, options: [] });
  });
  it("rejects mismatched ids self parents and duplicate heads", () => {
    rejects(M.MemoryOperation, { ...operation, memoryId: id(9) });
    rejects(M.MemoryRevision, { ...revision, parents: [id(3)] });
    rejects(M.MemoryOperation, { ...operation, expectedHeads: [id(5), id(5)] });
  });
  it("rejects unsupported protocol and unknown fields", () => {
    rejects(M.MemoryOperation, { ...operation, protocolVersion: 2 });
    rejects(M.MemoryOperation, { ...operation, credential: "synthetic" });
    rejects(M.MemoryOperation, { ...operation, payload: { ...payload, credential: "synthetic" } });
  });
  it("rejects excess fields on default decode encode and make paths", () => {
    for (const [schema, raw] of [
      [M.MemoryModelSelection, { ...selection, extra: true }],
      [M.MemoryModelSelection, { ...selection, options: [{ id: "x", value: false, extra: true }] }],
      [
        M.MemoryImportProviderInput,
        { memorySpaceId: id(), action: "discover", format: "codex", path: "/private" },
      ],
      [M.MemoryHubSettings, { mode: "disabled", endpoint: "https://old.invalid" }],
      [
        M.MemoryChangeSignal,
        { kind: "reset", memorySpaceId: id(), projectionWatermark: 1, text: "private" },
      ],
    ] as const) {
      rejects(schema, raw);
      expect(() => Schema.encodeUnknownSync(schema)(raw)).toThrow();
      expect(() => Schema.decodeSync(Schema.toCodecJson(schema))(raw)).toThrow();
      expect(() => Schema.encodeUnknownSync(Schema.toCodecJson(schema))(raw)).toThrow();
      expect(() => schema.make(raw as never)).toThrow();
      expect(() => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" })(raw)).toThrow();
    }
  });
  it("requires empty objects at every empty memory input boundary", () => {
    for (const [schema, rpc] of [
      [M.MemorySyncStatusInput, M.WsMemorySyncStatusRpc],
      [M.MemoryHubSettingsGetInput, M.WsMemoryHubSettingsGetRpc],
      [M.MemoryOwnerSourceReadPolicyGetInput, M.WsMemoryOwnerSourceReadPolicyGetRpc],
    ] as const) {
      const encode = Schema.encodeUnknownSync(schema);
      const rpcDecode = Schema.decodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema));
      const rpcEncode = Schema.encodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema));
      round(schema, {});
      expect(schema.make({})).toEqual({});
      expect(rpcDecode({})).toEqual({});
      expect(rpcEncode({})).toEqual({});
      for (const raw of [
        { endpoint: "x" },
        [],
        ["x"],
        "x",
        1,
        false,
        null,
        undefined,
        { [Symbol("extra")]: true },
        Object.defineProperty({}, "extra", { value: true }),
      ]) {
        rejects(schema, raw);
        expect(() => encode(raw)).toThrow();
        expect(() => schema.make(raw as never)).toThrow();
        expect(() => rpcDecode(raw)).toThrow();
        expect(() => rpcEncode(raw)).toThrow();
      }
    }
  });
  it("encodes events without memory or judgment bodies", () => {
    const value = decode(M.MemoryOperation, operation);
    const json = M.encodeMemoryEventMetadata(value);
    expect(json).not.toContain("Synthetic memory");
    expect(json).not.toContain("evidence");
    expect(M.decodeMemoryOperation(M.encodeMemoryOperation(value))).toEqual(value);
    expect(() =>
      M.encodeMemoryEventMetadata({
        ...value,
        revision: { ...revision, credential: "synthetic" },
      } as never),
    ).toThrow();
  });
  it("decodes provenance from a newer import format and keeps known formats byte-identical", () => {
    const importSource = (format: string) => ({
      sourceId: id(9),
      format,
      parserVersion: "aside-semantic-v1",
      sourceLocator: "aside/default/slot:agent",
      sourceItemKey: "agent/git.md#current",
      sourceFingerprint: "a".repeat(64),
      contentFingerprint: "b".repeat(64),
      sourceAliases: [],
      acceptedContentFingerprints: [],
    });
    const withFormat = (format: string) => ({
      ...operation,
      revision: {
        ...revision,
        provenance: { environmentId: "env", importSource: importSource(format) },
      },
    });
    const known = decode(M.MemoryOperation, withFormat("omo"));
    expect(M.encodeMemoryOperation(known)).toBe(
      M.encodeMemoryOperation(decode(M.MemoryOperation, withFormat("omo"))),
    );
    expect(JSON.parse(M.encodeMemoryOperation(known)).revision.provenance.importSource).toEqual(
      importSource("omo"),
    );
    const newer = decode(M.MemoryOperation, withFormat("aside"));
    expect(M.decodeMemoryOperation(M.encodeMemoryOperation(newer))).toEqual(newer);
    for (const format of ["", "Aside", "a".repeat(33), "aside/v2"])
      rejects(M.MemoryOperation, withFormat(format));
    rejects(M.MemoryImportFormat, "aside");
  });
  it("encodes tombstones without recoverable content", () => {
    const value = decode(M.MemoryOperation, {
      protocolVersion: 1,
      operationId: id(4),
      memorySpaceId: id(),
      originEnvironmentId: "env",
      memoryId: id(2),
      expectedHeads: [],
      kind: "forget",
      tombstone,
    });
    expect(M.encodeMemoryEventMetadata(value)).not.toContain("Synthetic memory");
    rejects(M.MemoryTombstone, { ...tombstone, text: "body" });
  });
  it("accepts stale structurally valid forget heads", () =>
    round(M.MemoryOperation, {
      protocolVersion: 1,
      operationId: id(6),
      memorySpaceId: id(),
      originEnvironmentId: "other",
      memoryId: id(2),
      expectedHeads: [id(9)],
      kind: "forget",
      tombstone,
    }));
  it("enforces payload limits at equality and overflow", () => {
    round(M.MemoryPayload, { ...payload, text: "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES) });
    rejects(M.MemoryPayload, { ...payload, text: "x".repeat(M.MEMORY_BODY_MAX_UTF8_BYTES + 1) });
    round(M.MemoryPayload, {
      ...payload,
      text: "한".repeat(Math.floor(M.MEMORY_BODY_MAX_UTF8_BYTES / 3)),
    });
  });
});
const visible = { exposure: "visible", reasons: [], deferred: [], cleanupPending: false };
const held = {
  exposure: "held",
  reasons: ["scanner_pending"],
  deferred: [],
  cleanupPending: false,
};
const receipt = {
  operationId: id(4),
  memoryId: id(2),
  operationDigest: "a".repeat(64),
  outcome: "accepted",
  hubSequence: 1,
};
const compact = {
  memorySpaceId: id(),
  originEnvironmentId: "env",
  operationKind: "upsert",
  receipt,
  revisionId: id(3),
  resolutionId: null,
  revertsResolutionId: null,
  attemptId: null,
  fencingToken: null,
  reportGuard: null,
};
const identity = {
  memorySpaceId: id(),
  memoryId: id(2),
  scope: { kind: "user" },
  creatingEnvironmentId: "env",
  createOperationId: id(4),
  createdAtUtc: now,
};
const fence = { memorySpaceId: id(), memoryId: id(2), highestFencingToken: 7, activeLease: null };
const checkpoint = {
  memorySpaceId: id(),
  checkpointSequence: 1,
  retentionFloor: 0,
  causalBoundary: { checkpointSequence: 1, boundaryId: "boundary" },
  pageOrdinal: 0,
  items: [],
  revisions: [],
  tombstones: [],
  conflicts: [],
  resolutions: [],
  compactReceipts: [compact],
  identities: [identity],
  fences: [fence],
  suppressions: [],
  importLineage: [],
  nextCursor: null,
  bootstrapComplete: true,
};
const lease = {
  memorySpaceId: id(),
  memoryId: id(2),
  conflictId: id(8),
  conflictHeadSet: [id(3), id(5)],
  holderEnvironmentId: "env",
  attemptId: id(4),
  frozenDefaultModelSelection: selection,
  fencingToken: 7,
  claimedAtHubTime: now,
  expiresAtHubTime: "2026-10-14T00:02:00.000Z",
  attemptDeadlineHubTime: "2026-10-14T00:10:00.000Z",
};
const resolution = {
  resolutionId: id(7),
  memorySpaceId: id(),
  memoryId: id(2),
  inputRevisionIds: [id(5), id(6)],
  inputPayloadRefs: [id(5), id(6)],
  judgmentRef: id(7),
  requestedModelSelection: selection,
  effectiveProvider: "codex",
  effectiveModel: "effective",
  resolvingEnvironmentId: "env",
  fencingToken: 7,
  resultRevisionId: id(3),
  appliedAtUtc: now,
  revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
};
const history = {
  memoryId: id(2),
  revisions: [{ revision, payload: null }],
  resolutions: [{ resolution, payload: null }],
  tombstone: null,
  reports: [],
  revertResults: [],
  localAvailability: visible,
  nextCursor: null,
};
describe("memory sync and views", () => {
  it("round-trips each operation arm", () => {
    round(M.MemoryOperation, operation);
    round(M.MemoryOperation, {
      protocolVersion: 1,
      operationId: id(4),
      memorySpaceId: id(),
      originEnvironmentId: "env",
      memoryId: id(2),
      expectedHeads: [],
      kind: "forget",
      tombstone,
    });
    round(M.MemoryOperation, {
      ...operation,
      kind: "resolve",
      expectedHeads: [id(5), id(6)],
      revision: { ...revision, parents: [id(5), id(6)] },
      resolution,
      resolutionPayload: { resolutionId: id(7), judgment: "Synthetic decision" },
      conflictId: id(8),
      fencingToken: 7,
    });
    round(M.MemoryOperation, {
      ...operation,
      kind: "revert",
      expectedHeads: [id(5)],
      revision: { ...revision, parents: [id(5)] },
      revertsResolutionId: id(7),
      restoredRevisionId: id(6),
    });
  });
  it("rejects resolve authority in client upsert", () => {
    rejects(M.MemoryUpsertInput, {
      memorySpaceId: id(),
      operationId: id(4),
      memoryId: id(2),
      expectedHeads: [],
      scope: { kind: "user" },
      assertionKind: "fact",
      payload,
      baseBoundary: null,
      kind: "resolve",
      fencingToken: 7,
    });
  });
  it("keeps purged history payload nullable", () => round(M.MemoryHistoryPage, history));
  it("requires selected original and one expected head for revert", () => {
    const v = {
      memorySpaceId: id(),
      memoryId: id(2),
      operationId: id(4),
      resolutionId: id(7),
      restoredRevisionId: id(6),
      expectedHeads: [id(5)],
    };
    round(M.MemoryRevertResolutionInput, v);
    rejects(M.MemoryRevertResolutionInput, { ...v, expectedHeads: [] });
    const { restoredRevisionId: _, ...missing } = v;
    rejects(M.MemoryRevertResolutionInput, missing);
  });
  it("enforces snapshot Unicode and UTF8 limits including wrappers", () => {
    const base = { protocolVersion: 1, memorySpaceId: id(), projectionWatermark: 1, items: [] };
    const length = M.MEMORY_CONTEXT_MAX_CHARS - Array.from(M.MEMORY_CONTEXT_OUTER_FRAME).length;
    round(M.MemoryContextSnapshot, { ...base, renderedText: "😀".repeat(length) });
    rejects(M.MemoryContextSnapshot, { ...base, renderedText: "😀".repeat(length + 1) });
  });
  it("includes outer-frame cost in snapshot equality", () => {
    const base = { protocolVersion: 1, memorySpaceId: id(), projectionWatermark: 0, items: [] };
    round(M.MemoryContextSnapshot, {
      ...base,
      renderedText: "x".repeat(6000 - M.MEMORY_CONTEXT_OUTER_FRAME.length),
    });
    rejects(M.MemoryContextSnapshot, { ...base, renderedText: "x".repeat(6000) });
  });
  it("round-trips permanent checkpoint ledger records after purge", () => {
    const p = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [{ revision, payload: null }],
    });
    expect(M.validateMemoryCheckpointRecords([p])).toBe(true);
  });
  it("round-trips forget-created identities and body-free refusal-only checkpoints", () => {
    const deleted = {
      ...compact,
      operationKind: "forget",
      revisionId: null,
      receipt: { ...receipt, outcome: "deleted" },
    };
    const forgotten = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [],
      items: [],
      tombstones: [tombstone],
      compactReceipts: [deleted],
    });
    expect(M.validateMemoryCheckpointRecords([forgotten])).toBe(true);
    const refusal = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      identities: [],
      fences: [],
      revisions: [],
      items: [],
      compactReceipts: [
        {
          ...compact,
          revisionId: null,
          receipt: { ...receipt, outcome: "rejected", failureCode: "identity_mismatch" },
        },
      ],
    });
    expect(M.validateMemoryCheckpointRecords([refusal])).toBe(true);
    expect(M.validateMemoryCheckpointRecords([{ ...forgotten, tombstones: [] }])).toBe(false);
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, { ...checkpoint, identities: [], fences: [] }),
      ]),
    ).toBe(false);
    expect(
      M.validateMemoryCheckpointRecords([
        { ...refusal, compactReceipts: [decode(M.MemoryCompactReceipt, compact)] },
      ]),
    ).toBe(false);
  });
  it("preserves original digest outcome and report retry identities", () => {
    expect(round(M.MemoryCompactReceipt, compact).receipt).toEqual(receipt);
    const replay = { ...compact, upsertRequestDigest: "a".repeat(64) };
    expect(round(M.MemoryCompactReceipt, replay).upsertRequestDigest).toBe("a".repeat(64));
    rejects(M.MemoryCompactReceipt, { ...replay, upsertRequestDigest: "body" });
    rejects(M.MemoryCompactReceipt, {
      ...replay,
      operationKind: "forget",
      revisionId: null,
      receipt: { ...receipt, outcome: "deleted" },
    });

    rejects(M.MemoryCompactReceipt, {
      ...compact,
      reportGuard: {
        reportId: "b".repeat(64),
        resolvingEnvironmentId: "env",
        resolutionId: id(7),
        outcome: "resolved",
      },
    });
  });
  it("rejects mismatched duplicate or missing checkpoint ledger identities", () => {
    for (const bad of [
      { ...checkpoint, identities: [] },
      { ...checkpoint, fences: [] },
      { ...checkpoint, identities: [identity, identity] },
      {
        ...checkpoint,
        revisions: [
          {
            revision: {
              ...revision,
              scope: {
                kind: "project",
                projectKey: { kind: "explicit", sharedProjectId: "wrong" },
              },
            },
            payload: null,
          },
        ],
      },
    ])
      expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, bad)])).toBe(
        false,
      );
  });
  it("rejects incomplete ordinals and boundary mismatches", () => {
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, { ...checkpoint, pageOrdinal: 1 }),
      ]),
    ).toBe(false);
    rejects(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
    });
  });
  it("links retained resolutions to the same memory resolver and input/result revisions", () => {
    const resolveReceipt = {
      ...compact,
      operationKind: "resolve",
      receipt: {
        ...receipt,
        operationId: id(12),
        hubSequence: 2,
        resolutionApproval: {
          resolutionId: id(7),
          appliedAtUtc: now,
          revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
        },
      },
      revisionId: id(3),
      resolutionId: id(7),
      attemptId: id(13),
      fencingToken: 7,
      reportGuard: {
        reportId: "1de81be9ef4203181b25b4fc4996a81492602dc4b6e61205546257fbb04e8e90",
        resolvingEnvironmentId: "env",
        resolutionId: id(7),
        outcome: "resolved",
      },
    };
    const input = (revisionId: string, operationId: string, memoryId = id(2)) => ({
      revision: { ...revision, memoryId, revisionId, payloadRef: revisionId, operationId },
      payload: null,
    });
    const bIdentity = { ...identity, memoryId: id(20), createOperationId: id(21) };
    const bReceipt = {
      ...compact,
      receipt: { ...receipt, memoryId: id(20), operationId: id(21) },
      revisionId: id(22),
    };
    const result = {
      revision: { ...revision, operationId: id(12), parents: [id(5), id(6)] },
      payload: null,
    };
    const page = {
      ...checkpoint,
      checkpointSequence: 2,
      causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
      identities: [identity, bIdentity],
      fences: [fence, { ...fence, memoryId: id(20) }],
      compactReceipts: [
        { ...compact, revisionId: id(5) },
        { ...compact, receipt: { ...receipt, operationId: id(14) }, revisionId: id(6) },
        resolveReceipt,
        bReceipt,
      ],
      revisions: [input(id(5), id(4)), input(id(6), id(14)), result, input(id(22), id(21), id(20))],
      resolutions: [{ resolution, payload: null }],
    };
    expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, page)])).toBe(true);
    const emptyLedger = {
      ...page,
      pageOrdinal: 1,
      identities: [],
      fences: [],
      compactReceipts: [],
      revisions: [],
      resolutions: [],
    };
    for (const collection of [
      "identities",
      "fences",
      "compactReceipts",
      "revisions",
      "resolutions",
    ] as const) {
      expect(
        M.validateMemoryCheckpointRecords([
          decode(M.MemoryHubCheckpointPage, {
            ...page,
            nextCursor: "next",
            bootstrapComplete: false,
          }),
          decode(M.MemoryHubCheckpointPage, {
            ...emptyLedger,
            [collection]: [page[collection][0]],
          }),
        ]),
      ).toBe(false);
    }
    const { resolutionApproval: _approval, ...withoutApproval } = resolveReceipt.receipt;
    const rejectedAttempt = {
      ...resolveReceipt,
      receipt: {
        ...withoutApproval,
        operationId: id(30),
        outcome: "rejected",
        failureCode: "fenced",
      },
      revisionId: null,
      reportGuard: null,
    };
    // An earlier rejected attempt does not hide the committed resolve receipt.
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, {
          ...page,
          compactReceipts: [rejectedAttempt, ...page.compactReceipts],
        }),
      ]),
    ).toBe(true);
    expect(
      M.validateMemoryCheckpointRecords([
        decode(M.MemoryHubCheckpointPage, {
          ...page,
          compactReceipts: [
            ...page.compactReceipts,
            {
              ...resolveReceipt,
              receipt: { ...resolveReceipt.receipt, operationId: id(31) },
            },
          ],
        }),
      ]),
    ).toBe(false);
    for (const bad of [
      // Both identities and fences exist: a retained B resolution cannot reuse A's receipt.
      {
        ...page,
        resolutions: [{ resolution: { ...resolution, memoryId: id(20) }, payload: null }],
      },
      {
        ...page,
        resolutions: [
          { resolution: { ...resolution, resolvingEnvironmentId: "other" }, payload: null },
        ],
      },
      { ...page, revisions: page.revisions.filter((v) => v.revision.revisionId !== id(3)) },
      { ...page, revisions: page.revisions.filter((v) => v.revision.revisionId !== id(6)) },
      {
        ...page,
        resolutions: [
          {
            resolution: {
              ...resolution,
              inputRevisionIds: [id(5), id(22)],
              inputPayloadRefs: [id(5), id(22)],
            },
            payload: null,
          },
        ],
        revisions: [
          page.revisions[0],
          page.revisions[1],
          { ...result, revision: { ...result.revision, parents: [id(5), id(22)] } },
          page.revisions[3],
        ],
      },
      {
        ...page,
        revisions: [
          page.revisions[0],
          page.revisions[1],
          { ...result, revision: { ...result.revision, parents: [id(5)] } },
          page.revisions[3],
        ],
      },
      {
        ...page,
        revisions: [
          page.revisions[0],
          page.revisions[1],
          { ...result, revision: { ...result.revision, provenance: { environmentId: "other" } } },
          page.revisions[3],
        ],
      },
    ])
      expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, bad)])).toBe(
        false,
      );
  });
  it("restores deletion suppression and released lease fencing across pages", () => {
    const deletion = { ...receipt, operationId: id(9), outcome: "deleted", hubSequence: 2 };
    const common = {
      ...checkpoint,
      checkpointSequence: 2,
      causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
    };
    const rows = Array.from({ length: 101 }, (_, i) => ({
      kind: "sourceKey",
      memorySpaceId: id(),
      memoryId: id(2),
      deleteOperationId: id(9),
      sourceKey: { environmentId: "env", sourceId: id(10), sourceItemKey: `item-${i}` },
    }));
    const first = decode(M.MemoryHubCheckpointPage, {
      ...common,
      compactReceipts: [
        compact,
        { ...compact, operationKind: "forget", receipt: deletion, revisionId: null },
      ],
      tombstones: [{ ...tombstone, deleteOperationId: id(9) }],
      suppressions: rows.slice(0, 90),
      nextCursor: "next",
      bootstrapComplete: false,
    });
    const second = decode(M.MemoryHubCheckpointPage, {
      ...common,
      pageOrdinal: 1,
      compactReceipts: [],
      identities: [],
      fences: [],
      suppressions: rows.slice(90),
    });
    expect(M.validateMemoryCheckpointRecords([first, second])).toBe(true);
    expect(first.fences[0]?.highestFencingToken).toBe(7);
  });
  it("enforces combined checkpoint record and UTF8 bounds at equality and overflow", () => {
    const rows = Array.from({ length: 98 }, (_, i) => ({ ...identity, memoryId: id(i + 20) }));
    round(M.MemoryHubCheckpointPage, { ...checkpoint, identities: rows });
    rejects(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      identities: [...rows, identity],
    });
  });
  it("uses UTC lease timestamps and safe integer fences", () => {
    round(M.MemoryResolutionLease, lease);
    rejects(M.MemoryResolutionLease, { ...lease, fencingToken: Number.MAX_SAFE_INTEGER + 1 });
    rejects(M.MemoryResolutionLease, { ...lease, expiresAtHubTime: "2026-10-14T00:02:00Z" });
    rejects(M.MemoryResolutionLease, { ...lease, expiresAtHubTime: "2026-10-14T00:11:00.000Z" });
  });
  it("round-trips pinned model options and lease timestamps", () => {
    expect(round(M.MemoryResolutionLease, lease).frozenDefaultModelSelection).toEqual(selection);
    rejects(M.MemoryResolutionLease, {
      ...lease,
      frozenDefaultModelSelection: { ...selection, options: [{ id: "x", value: 2 }] },
    });
  });
  it("requires failure code on rejected receipts", () => {
    rejects(M.MemoryHubReceipt, { ...receipt, outcome: "rejected" });
    round(M.MemoryHubReceipt, { ...receipt, outcome: "rejected", failureCode: "invalid_output" });
  });
  it("round-trips metadata-only checkpoint pages and rejects mixed normal paging", () => {
    round(M.MemoryHubCheckpointPage, checkpoint);
    rejects(M.MemoryHubPullInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      afterSequence: 0,
      cursor: "bad",
    });
    rejects(M.MemoryHubPullResult, {
      highWatermark: 1,
      throughSequence: 1,
      hasMore: false,
      entries: [
        { kind: "metadata", operationKind: "upsert", hubSequence: 1, receipt, memoryId: id(2) },
      ],
      checkpoint,
    });
  });
  it("rejects body-bearing quarantined forgotten and blocked items", () => {
    for (const item of [
      {
        status: "blocked",
        scope: { kind: "user" },
        failureCode: "scanner_pending",
        localAvailability: held,
      },
      {
        status: "quarantined",
        scope: { kind: "user" },
        conflict: {
          conflictId: id(8),
          memorySpaceId: id(),
          memoryId: id(2),
          heads: [id(3), id(5)],
          status: "quarantined",
        },
        localAvailability: held,
      },
      {
        status: "forgotten",
        tombstone,
        localAvailability: { ...visible, exposure: "forgotten", cleanupPending: true },
      },
    ]) {
      const v = { memorySpaceId: id(), memoryId: id(2), pendingSync: false, ...item };
      round(M.MemoryItem, v);
      rejects(M.MemoryItem, { ...v, payload });
    }
  });
  it("round-trips report reference and delivery pointers", () => {
    round(M.MemoryReportReference, {
      memorySpaceId: id(),
      environmentId: "env",
      memoryId: id(2),
      resolutionId: id(7),
    });
    const r = {
      reportId: "a".repeat(64),
      operationId: id(4),
      outcome: "resolved",
      resolvingEnvironmentId: "env",
      resolutionId: id(7),
      state: "delivered",
      reportThread: thread,
      sequence: 1,
    };
    round(M.MemoryReportDelivery, r);
    rejects(M.MemoryReportDelivery, { ...r, reportThread: null });
  });
  it("validates model evidence against input without letting output choose ids", () => {
    const input = decode(M.GenerateMemorySummaryInput, {
      cwd: "scratch",
      sourceThread: thread,
      sourceWatermark: watermark,
      messages: [{ messageId: "m1", text: "Synthetic", completed: true }],
      modelSelection: selection,
    });
    const result = decode(M.GenerateMemorySummaryResult, {
      text: "Synthetic",
      assertionKind: "fact",
      evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: ["m1"] }],
    });
    expect(M.validateMemoryGenerationResult(input, result)).toBe(true);
    expect(
      M.validateMemoryGenerationResult(input, {
        ...result,
        evidence: [{ ...result.evidence[0]!, messageIds: [M.MessageId.make("unknown")] }],
      }),
    ).toBe(false);
    const cumulative = decode(M.GenerateMemorySummaryInput, {
      ...input,
      messages: [{ messageId: "m2", text: "Later", completed: true }],
      previousSummary: {
        text: result.text,
        evidence: result.evidence,
        derivedFromMemoryRevisions: [],
      },
    });
    expect(M.validateMemoryGenerationResult(cumulative, result)).toBe(true);
    expect(
      M.validateMemoryGenerationResult(cumulative, {
        ...result,
        evidence: [{ ...result.evidence[0]!, messageIds: [M.MessageId.make("unknown")] }],
      }),
    ).toBe(false);
    rejects(M.GenerateMemorySummaryResult, { ...result, revisionId: id(3) });
  });
});
describe("memory bounded transport", () => {
  it("round-trips eleven hub requests and receipts", () => {
    const hub = { protocolVersion: 1, memorySpaceId: id() };
    const leaseKey = {
      ...hub,
      memoryId: id(2),
      conflictId: id(8),
      holderEnvironmentId: "env",
      attemptId: id(4),
    };
    const source = {
      ...hub,
      requestId: id(11),
      memoryId: id(2),
      sourceThread: thread,
      sourceWatermark: watermark,
      messageIds: ["m1"],
      authorizedScopes: ["memory:read", "orchestration:read"],
    };
    const requests: [Schema.Top, unknown][] = [
      [M.MemoryHubJoinInput, { ...hub, environmentId: "env" }],
      [M.MemoryHubPushInput, { ...hub, environmentId: "env", operations: [operation] }],
      [M.MemoryHubPullInput, { ...hub, environmentId: "env", afterSequence: 0 }],
      [
        M.MemoryHubClaimInput,
        { ...leaseKey, conflictHeadSet: [id(3), id(5)], frozenDefaultModelSelection: selection },
      ],
      [M.MemoryHubRenewInput, { ...leaseKey, fencingToken: 7 }],
      [M.MemoryHubReleaseInput, { ...leaseKey, fencingToken: 7 }],
      [
        M.MemoryHubApplyResolutionInput,
        {
          ...hub,
          holderEnvironmentId: "env",
          attemptId: id(4),
          operation: {
            ...operation,
            kind: "resolve",
            expectedHeads: [id(5), id(6)],
            revision: { ...revision, parents: [id(5), id(6)] },
            resolution,
            resolutionPayload: { resolutionId: id(7), judgment: "Decision" },
            conflictId: id(8),
            fencingToken: 7,
          },
        },
      ],
      [M.MemoryHubSourceReadRequestInput, source],
      [M.MemoryHubSourceReadCollectInput, { ...hub, limit: 32 }],
      [
        M.MemoryHubSourceReadRespondInput,
        {
          ...hub,
          requestId: id(11),
          outcome: { kind: "denied", requiredPermission: "orchestration:read" },
        },
      ],
      [M.MemoryHubSourceReadResultInput, { ...hub, requestId: id(11) }],
    ];
    for (const [schema, value] of requests) round(schema, value);
    expect(Object.values(M.MEMORY_HUB_PATHS)).toHaveLength(11);
    round(M.MemoryHubReceipt, receipt);
  });
  it("preserves resolve push envelopes admission errors and accepted replay receipts", () => {
    // Push retains the resolve envelope so the stateful hub can replay an existing receipt; new admission is exclusively apply-resolution.
    const value = {
      ...operation,
      kind: "resolve",
      expectedHeads: [id(5), id(6)],
      revision: { ...revision, parents: [id(5), id(6)] },
      resolution,
      resolutionPayload: { resolutionId: id(7), judgment: "Decision" },
      conflictId: id(8),
      fencingToken: 7,
    };
    round(M.MemoryHubPushInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      operations: [value],
    });
    round(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "lease_required" });
    round(M.MemoryHubPushResult, { receipts: [receipt] });
  });
  it("unions bounded tombstone fragments preserving original deletion audit", () => {
    const keys = Array.from({ length: 101 }, (_, i) => ({
      environmentId: "env",
      sourceId: id(10),
      sourceItemKey: `key-${i}`,
    }));
    const fragments = [
      round(M.MemoryTombstone, { ...tombstone, suppressedSourceKeys: keys.slice(0, 100) }),
      round(M.MemoryTombstone, { ...tombstone, suppressedSourceKeys: keys.slice(100) }),
    ];
    expect(
      new Set(fragments.flatMap((t) => t.suppressedSourceKeys.map((k) => k.sourceItemKey))).size,
    ).toBe(101);
    expect(fragments.every((t) => t.deleteOperationId === id(4) && t.deletedAtUtc === now)).toBe(
      true,
    );
    rejects(M.MemoryTombstone, { ...tombstone, suppressedSourceKeys: keys });
  });
  it("enforces page batch and payload limits at equality and overflow", () => {
    const v = { ...operation };
    round(M.MemoryHubPushInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      operations: Array.from({ length: 100 }, () => ({ ...v })),
    });
    rejects(M.MemoryHubPushInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      environmentId: "env",
      operations: Array.from({ length: 101 }, () => ({ ...v })),
    });
    round(M.MemorySourcePage, {
      sourceThread: thread,
      watermark,
      messages: Array.from({ length: 100 }, (_, i) => ({ messageId: `m${i}`, text: "x" })),
      nextCursor: null,
    });
    rejects(M.MemorySourcePage, {
      sourceThread: thread,
      watermark,
      messages: [{ messageId: "m", text: "x".repeat(65536) }],
      nextCursor: null,
    });
  });
  it("round-trips all import actions outcomes and partial receipts", () => {
    for (const action of [
      { action: "discover", format: "codex" },
      { action: "preview", sourceId: id(10) },
      { action: "status", operationId: id(4) },
      {
        action: "apply",
        sourceId: id(10),
        sessionId: "session",
        operationId: id(4),
        items: [
          { sourceItemKey: "item", sourceFingerprint: "a".repeat(64), scope: { kind: "user" } },
        ],
      },
    ])
      round(M.MemoryImportProviderInput, { memorySpaceId: id(), ...action });
    for (const outcome of M.MemoryImportOutcome.literals)
      round(M.MemoryImportItemResult, {
        sourceItemKey: "item",
        outcome,
        memoryId: null,
        revisionId: null,
        ...(outcome === "rejected" ? { issue: "secret_detected" } : {}),
      });
    round(M.MemoryImportReceipt, {
      operationId: id(4),
      sourceId: id(10),
      sessionId: "session",
      sessionNewItems: 1,
      sessionBodyBytes: 10,
      state: "partial",
      items: [],
      remaining: 1,
    });
  });
  it("rejects start cancel paths bodies missing import fingerprints and project selectors without ScopedProjectRef", () => {
    for (const action of ["start", "cancel"])
      rejects(M.MemoryImportProviderInput, { memorySpaceId: id(), action });
    rejects(M.MemoryImportProviderInput, {
      memorySpaceId: id(),
      action: "preview",
      sourceId: id(10),
      path: "/private",
    });
    rejects(M.MemoryImportProviderInput, {
      memorySpaceId: id(),
      action: "apply",
      sourceId: id(10),
      sessionId: "session",
      operationId: id(4),
      items: [
        {
          sourceItemKey: "item",
          sourceFingerprint: "a".repeat(64),
          scope: { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "shared" } },
        },
      ],
    });
  });
  it("round-trips hub admin actions without leaking credential to settings", () => {
    const base = { requestId: id(4), expectedVersion: 0 };
    for (const action of [
      { action: "configure", settings: { mode: "disabled" } },
      { action: "provisionMember", environmentId: "env" },
      { action: "rotateMemberCredential", environmentId: "env" },
      { action: "revokeMember", environmentId: "env" },
      {
        action: "installCredential",
        hubEnvironmentId: "env",
        endpoint: "https://hub.invalid",
        memorySpaceId: id(),
        credential: "a".repeat(43),
      },
      { action: "acknowledgeCredential", credentialRequestId: id(4) },
    ])
      round(M.MemoryHubSettingsUpdateInput, { ...base, ...action });
    rejects(M.MemoryHubSettings, { mode: "disabled", credential: "synthetic" });
  });
  it("round-trips held visible-unindexed and forgotten cleanup status", () => {
    for (const exposure of ["visible", "held", "forgotten"])
      round(M.MemoryLocalAvailability, { ...visible, exposure, cleanupPending: true });
    round(M.MemoryIndexCoverage, {
      status: "partial",
      eligibleItems: 2,
      indexedItems: 1,
      unindexedItems: 1,
      projectionWatermark: 1,
    });
    rejects(M.MemoryIndexCoverage, {
      status: "available",
      eligibleItems: 2,
      indexedItems: 1,
      unindexedItems: 1,
      projectionWatermark: 1,
    });
    rejects(M.MemoryHistoryPage, {
      ...history,
      localAvailability: held,
      revisions: [{ revision, payload }],
    });
  });
});

describe("memory additional boundary fixtures", () => {
  it("rejects excess error fields on make and constructor paths", () => {
    for (const [ErrorClass, props] of [
      [M.MemoryRpcError, { code: "invalid_output" }],
      [M.MemoryHubError, { code: "invalid_output" }],
      [M.MemoryImportRpcError, { issue: "storage_failed" }],
    ] as const) {
      const made = ErrorClass.make(props as never);
      const constructed = new ErrorClass(props as never);
      expect(made).toBeInstanceOf(ErrorClass);
      expect(constructed).toBeInstanceOf(ErrorClass);
      expect(made).toMatchObject({ ...props, _tag: ErrorClass.identifier });
      expect(constructed).toMatchObject({ ...props, _tag: ErrorClass.identifier });
      expect(ErrorClass.make(made as never)).toBe(made);
      for (const options of [
        undefined,
        { parseOptions: { onExcessProperty: "ignore" as const } },
        { disableChecks: true, parseOptions: { disableChecks: true } },
      ]) {
        const raw = { ...props, cause: "private" };
        expect(() => ErrorClass.make(raw as never, options)).toThrow();
        expect(() => new ErrorClass(raw as never, options)).toThrow();
      }
    }
  });
  it("validates capacity categories on safe errors", () => {
    const capacity = {
      code: "capacity_exceeded",
      dimension: "body",
      current: 16385,
      limit: 16384,
      reclaimable: 0,
    };
    round(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "capacity_exceeded", capacity });
    rejects(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "capacity_exceeded" });
    rejects(M.MemoryHubError, { _tag: "MemoryHubError", code: "invalid_output", capacity });
    rejects(M.MemoryRpcError, { _tag: "MemoryRpcError", code: "invalid_output", cause: "private" });
    rejects(M.MemoryImportRpcError, { _tag: "MemoryImportRpcError", issue: "capacity_exceeded" });
  });
  it("preserves accepted compensation with local exposure hold", () => {
    const base = {
      operationId: id(4),
      memoryId: id(2),
      resolutionId: id(7),
      revertDeadlineUtc: resolution.revertDeadlineUtc,
    };
    round(M.MemoryRevertResult, { ...base, status: "pending" });
    round(M.MemoryRevertResult, {
      ...base,
      status: "accepted",
      receipt: {
        operationId: id(4),
        memoryId: id(2),
        outcome: "accepted",
        revisionId: id(3),
        pendingSync: false,
      },
      localAvailability: held,
    });
    rejects(M.MemoryRevertResult, {
      ...base,
      status: "accepted",
      receipt: {
        operationId: id(4),
        memoryId: id(2),
        outcome: "accepted",
        revisionId: null,
        pendingSync: true,
      },
      localAvailability: held,
    });
    rejects(M.MemoryRevertResult, { ...base, status: "forgotten", receipt: {} });
  });
  it("round-trips all deferred kinds and rejects duplicate or inconsistent states", () => {
    for (const kind of ["index", "scanner", "parent", "projection", "cleanup", "report"]) {
      const deferred = {
        kind,
        state: "held",
        reason: "scanner_pending",
        revisionId: id(3),
        generation: 1,
        sinceAtUtc: now,
      };
      round(M.MemoryDeferredStatus, deferred);
      rejects(M.MemoryDeferredStatus, { ...deferred, sinceAtUtc: null });
      rejects(M.MemoryLocalAvailability, { ...held, deferred: [deferred, deferred] });
    }
    for (const reason of M.MemoryDeferredReason.literals)
      round(M.MemoryLocalAvailability, { ...held, reasons: [reason] });
    rejects(M.MemoryLocalAvailability, { ...held, reasons: ["unknown"] });
  });
  it("round-trips processing counters and rejects inconsistent oldest timestamps", () => {
    const coverage = {
      status: "partial",
      eligibleItems: 2,
      indexedItems: 1,
      unindexedItems: 1,
      projectionWatermark: 3,
    };
    const status = {
      lastReceivedHubSequence: 4,
      receiveLag: 2,
      deferred: 1,
      oldestDeferredAtUtc: now,
      unindexedItems: 1,
      scannerHeldItems: 1,
      scannerPendingItems: 1,
      missingParentItems: 1,
      pendingCleanupItems: 1,
      reportBacklog: 1,
      reportFailed: 1,
      hubAdmissionFailures: 1,
      indexCoverage: coverage,
    };
    round(M.MemoryProcessingStatus, status);
    rejects(M.MemoryProcessingStatus, { ...status, oldestDeferredAtUtc: null });
    round(M.MemoryProcessingStatus, { ...status, deferred: 0, oldestDeferredAtUtc: null });
  });
  it("enforces encoded payload and source page UTF8 equality and overflow", () => {
    const page = {
      sourceThread: thread,
      watermark,
      messages: [{ messageId: "m1", text: "" }],
      nextCursor: null,
    };
    const overhead = new TextEncoder().encode(JSON.stringify(page)).length;
    round(M.MemorySourcePage, {
      ...page,
      messages: [{ messageId: "m1", text: "x".repeat(65536 - overhead) }],
    });
    rejects(M.MemorySourcePage, {
      ...page,
      messages: [{ messageId: "m1", text: "x".repeat(65537 - overhead) }],
    });
  });
  it("rejects forged admission mode on public input", () => {
    rejects(M.MemoryUpsertInput, {
      memorySpaceId: id(),
      operationId: id(4),
      memoryId: id(2),
      expectedHeads: [],
      scope: { kind: "user" },
      assertionKind: "fact",
      payload,
      baseBoundary: null,
      mode: "approvedReplica",
    });
  });
  it("retains canonical checkpoint body while local display is held", () => {
    const item = {
      status: "blocked",
      memorySpaceId: id(),
      memoryId: id(2),
      scope: { kind: "user" },
      failureCode: "scanner_pending",
      pendingSync: false,
      localAvailability: held,
    };
    const p = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      items: [item],
      revisions: [{ revision, payload }],
    });
    expect(p.revisions[0]?.payload?.text).toBe(payload.text);
    expect(M.validateMemoryCheckpointRecords([p])).toBe(true);
  });
});
describe("checkpoint byte and retry metadata bounds", () => {
  it("enforces checkpoint serialized UTF8 bytes at equality and overflow", () => {
    const revisions = Array.from({ length: 16 }, (_, i) => ({
      revision: { ...revision, revisionId: id(i + 20), payloadRef: id(i + 20) },
      payload: { ...payload, text: i === 15 ? "x" : "x".repeat(16384) },
    }));
    const page = { ...checkpoint, revisions };
    const size = new TextEncoder().encode(JSON.stringify(page)).length;
    const remaining = 262144 - size;
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThan(16384);
    const last = revisions[15]!;
    const equal = {
      ...page,
      revisions: [
        ...revisions.slice(0, 15),
        { ...last, payload: { ...payload, text: "x".repeat(1 + remaining) } },
      ],
    };
    expect(new TextEncoder().encode(JSON.stringify(equal)).length).toBe(262144);
    round(M.MemoryHubCheckpointPage, equal);
    rejects(M.MemoryHubCheckpointPage, {
      ...equal,
      revisions: [
        ...equal.revisions.slice(0, 15),
        { ...last, payload: { ...payload, text: "x".repeat(2 + remaining) } },
      ],
    });
  });
  it("preserves requested aliases and strict nested selections in checkpoint provenance", () => {
    const provenance = {
      environmentId: "env",
      providerInstanceId: "codex",
      provider: "codex",
      requestedModelSelection: selection,
      effectiveModel: "effective",
    };
    const p = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [{ revision: { ...revision, provenance }, payload: null }],
    });
    expect(p.revisions[0]?.revision.provenance.requestedModelSelection).toEqual(selection);
    rejects(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      revisions: [
        {
          revision: {
            ...revision,
            provenance: {
              ...provenance,
              requestedModelSelection: { ...selection, options: { effort: 123 } },
            },
          },
          payload: null,
        },
      ],
    });
  });
});

it("preserves well-formed report guard digests after detail purge for server verification", () => {
  const resolveReceipt = {
    ...compact,
    operationKind: "resolve",
    receipt: {
      ...receipt,
      operationId: id(12),
      hubSequence: 2,
      resolutionApproval: {
        resolutionId: id(7),
        appliedAtUtc: now,
        revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
      },
    },
    revisionId: id(3),
    resolutionId: id(7),
    attemptId: id(13),
    fencingToken: 7,
    reportGuard: {
      reportId: "1de81be9ef4203181b25b4fc4996a81492602dc4b6e61205546257fbb04e8e90",
      resolvingEnvironmentId: "env",
      resolutionId: id(7),
      outcome: "resolved",
    },
  };
  const page = {
    ...checkpoint,
    checkpointSequence: 2,
    causalBoundary: { checkpointSequence: 2, boundaryId: "boundary" },
    compactReceipts: [compact, resolveReceipt],
  };
  expect(M.validateMemoryCheckpointRecords([decode(M.MemoryHubCheckpointPage, page)])).toBe(true);
  expect(
    M.validateMemoryCheckpointRecords([
      decode(M.MemoryHubCheckpointPage, {
        ...page,
        compactReceipts: [
          compact,
          {
            ...resolveReceipt,
            reportGuard: { ...resolveReceipt.reportGuard, reportId: "b".repeat(64) },
          },
        ],
      }),
    ]),
  ).toBe(true);
  rejects(M.MemoryCheckpointReportGuard, {
    ...resolveReceipt.reportGuard,
    reportId: "not-a-digest",
  });
});
describe("memory binding and relay contracts", () => {
  const project = { environmentId: "env", projectId: "project" };
  const request = {
    requestId: id(11),
    memorySpaceId: id(),
    requesterEnvironmentId: "env",
    memoryId: id(2),
    sourceThread: thread,
    sourceWatermark: watermark,
    messageIds: ["m1"],
    limit: 20,
    authorizedScopes: ["memory:read", "orchestration:read"],
    expiresAtHubTime: now,
  };
  const page = {
    sourceThread: thread,
    watermark,
    messages: [{ messageId: "m1", text: "Synthetic source" }],
    nextCursor: null,
  };
  it("round trips binding actions and rejects foreign-shaped keys and extra fields", () => {
    for (const action of [
      { action: "setExplicit", sharedProjectId: "shared" },
      { action: "useRepository" },
    ])
      round(M.MemoryProjectBindingUpdateInput, {
        memorySpaceId: id(),
        project,
        requestId: id(4),
        expectedVersion: 0,
        ...action,
      });
    rejects(M.MemoryProjectBindingUpdateInput, {
      memorySpaceId: id(),
      project,
      requestId: id(4),
      expectedVersion: 0,
      action: "useRepository",
      repositoryKey: { kind: "repository", groupingKey: "forged" },
    });
    round(M.MemoryProjectBinding, {
      memorySpaceId: id(),
      project,
      projectKey: null,
      repositoryKey: null,
      version: 0,
    });
  });
  it("round trips body free reset forget and invalidation signals", () => {
    for (const kind of ["reset", "upsert", "forget", "invalidate"])
      round(M.MemoryChangeSignal, {
        kind,
        memorySpaceId: id(),
        projectionWatermark: 2,
        ...(kind === "reset" ? {} : { memoryId: id(2) }),
      });
  });
  it("rejects signal bodies and wrong watermarks", () => {
    rejects(M.MemoryChangeSignal, {
      kind: "reset",
      memorySpaceId: id(),
      projectionWatermark: 2,
      text: "private",
    });
    rejects(M.MemoryChangeSignal, {
      kind: "forget",
      memorySpaceId: id(),
      memoryId: id(2),
      projectionWatermark: -1,
    });
  });
  it("round trips all four relay requests outcomes and expired result", () => {
    round(M.MemoryHubSourceReadRequestInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(11),
      memoryId: id(2),
      sourceThread: thread,
      sourceWatermark: watermark,
      messageIds: ["m1"],
      limit: 20,
      authorizedScopes: ["memory:read", "orchestration:read"],
    });
    round(M.MemoryHubSourceReadCollectInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      limit: 32,
    });
    round(M.MemoryHubSourceReadRespondInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(11),
      outcome: { kind: "available", page },
    });
    round(M.MemoryHubSourceReadResultInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(11),
    });
    for (const outcome of [
      { kind: "available", page },
      { kind: "unavailable", code: "source_unavailable" },
      { kind: "denied", requiredPermission: "orchestration:read" },
    ])
      round(M.MemorySourceReadOutcome, outcome);
    round(M.MemoryHubSourceReadResultResult, { state: "expired", code: "source_unavailable" });
  });
  it("rejects wrong page thread message ids oversized outcome and noncanonical deadline", () => {
    const req = decode(M.MemorySourceReadRequest, request);
    const available = decode(M.MemorySourceReadOutcome, { kind: "available", page });
    expect(M.validateMemorySourceReadOutcome(req, available)).toBe(true);
    for (const bad of [
      { ...page, sourceThread: { ...thread, threadId: "wrong" } },
      { ...page, messages: [{ messageId: "unknown", text: "Synthetic" }] },
    ])
      expect(
        M.validateMemorySourceReadOutcome(
          req,
          decode(M.MemorySourceReadOutcome, { kind: "available", page: bad }),
        ),
      ).toBe(false);
    rejects(M.MemorySourceReadOutcome, {
      kind: "available",
      page: { ...page, messages: [{ messageId: "m1", text: "x".repeat(65536) }] },
    });
    rejects(M.MemorySourceReadRequest, { ...request, expiresAtHubTime: "2026-10-14T00:00:00Z" });
  });
  it("round-trips transient source request ids", () => {
    const source = M.MemorySourceReadRequestId.make(id(11));
    round(M.MemorySourceReadRequestId, source);
  });
});

describe("pending forget contracts", () => {
  it("bounds durable pending forget intents per environment", () => {
    expect(M.MEMORY_PENDING_FORGET_INTENTS_MAX).toBe(2000);
  });
  it("round-trips forget_pending failure and deferred reasons", () => {
    round(M.MemoryFailureCode, "forget_pending");
    round(M.MemoryDeferredReason, "forget_pending");
  });
  it("round-trips body-free blocked read and list items after receive and restart", () => {
    const item = {
      status: "blocked",
      memorySpaceId: id(),
      memoryId: id(2),
      scope: { kind: "user" },
      failureCode: "forget_pending",
      pendingSync: false,
      localAvailability: { ...held, reasons: ["forget_pending"] },
    };
    const received = round(M.MemoryItem, item);
    round(M.MemoryItem, JSON.parse(JSON.stringify(received)));
    rejects(M.MemoryItem, { ...item, payload });
    rejects(M.MemoryItem, { ...item, revision });
  });
});

describe("authoritative resolution approvals", () => {
  const approval = {
    resolutionId: id(7),
    appliedAtUtc: now,
    revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
  };
  const accepted = { ...receipt, resolutionApproval: approval };
  const metadata = {
    kind: "metadata",
    operationKind: "resolve",
    resolutionId: id(7),
    memoryId: id(2),
    hubSequence: 1,
    receipt: accepted,
  };
  it("validates purged resolve metadata independently of bodies", () => {
    round(M.MemoryHubEntry, metadata);
    rejects(M.MemoryHubEntry, { ...metadata, receipt });
    rejects(M.MemoryHubEntry, { ...metadata, resolutionId: id(9) });
    rejects(M.MemoryHubEntry, { ...metadata, operationKind: "upsert" });
    rejects(M.MemoryHubEntry, { ...metadata, operationKind: "revert" });
    rejects(M.MemoryHubEntry, { ...metadata, receipt: { ...accepted, outcome: "deleted" } });
    rejects(M.MemoryHubReceipt, { ...accepted, outcome: "rejected", failureCode: "fenced" });
  });
  it("accepts optional metadata compact guards and rejects inconsistent receipt identity or approval", () => {
    const compact = {
      memorySpaceId: id(),
      originEnvironmentId: "fixture",
      operationKind: "resolve",
      receipt: accepted,
      revisionId: id(4),
      resolutionId: id(7),
      revertsResolutionId: null,
      attemptId: id(3),
      fencingToken: 1,
      reportGuard: {
        reportId: "a".repeat(64),
        resolvingEnvironmentId: "fixture",
        resolutionId: id(7),
        outcome: "resolved",
      },
    };
    round(M.MemoryHubEntry, { ...metadata, compactReceipt: compact });
    round(M.MemoryHubEntry, metadata);
    for (const change of [
      { operationId: id(9) },
      { memoryId: id(9) },
      { operationDigest: "b".repeat(64) },
      { outcome: "conflicted" },
      { hubSequence: 2 },
      {
        resolutionApproval: {
          ...approval,
          appliedAtUtc: "2026-10-15T00:00:00.000Z",
          revertDeadlineUtc: "2026-11-14T00:00:00.000Z",
        },
      },
    ])
      rejects(M.MemoryHubEntry, {
        ...metadata,
        compactReceipt: { ...compact, receipt: { ...accepted, ...change } },
      });
    rejects(M.MemoryHubEntry, {
      ...metadata,
      compactReceipt: {
        ...compact,
        operationKind: "revert",
        attemptId: null,
        fencingToken: null,
        revertsResolutionId: id(7),
        reportGuard: { ...compact.reportGuard, outcome: "reverted" },
      },
    });
    rejects(M.MemoryHubEntry, { ...metadata, compactReceipt: { ...compact, resolutionId: id(9) } });
  });
  it("requires exactly thirty days only at the approval boundary", () => {
    round(M.MemoryResolutionApproval, approval);
    rejects(M.MemoryResolutionApproval, {
      ...approval,
      revertDeadlineUtc: "2026-11-13T00:00:00.001Z",
    });
    rejects(M.MemoryResolutionApproval, { ...approval, extra: true });
    round(M.MemoryResolution, { ...resolution, revertDeadlineUtc: "2026-10-15T00:00:00.000Z" });
  });
});

describe("WP4 cursor, owner policy and relay contracts", () => {
  const binding = decode(M.MemorySearchCursorBinding, {
    memorySpaceId: id(),
    queryDigest: "a".repeat(64),
    mode: "fts",
    scopeKey: "b".repeat(64),
  });
  const pair = {
    memorySpaceId: id(),
    ownerEnvironmentId: "owner",
    requesterEnvironmentId: "reader",
  };
  const ack = { ...pair, removalEpoch: 7, revokedThroughEpoch: 7 };
  it("binds search continuation to query, mode, space and canonical scope digest", () => {
    const cursor = M.encodeMemorySearchCursor(binding, M.MemoryId.make(id(2)));
    expect(cursor.length).toBeLessThanOrEqual(1024);
    const wire = JSON.parse(decodeURIComponent(cursor.slice(4)));
    expect(Object.keys(wire).sort()).toEqual(["afterMemoryId", "binding", "kind", "version"]);
    expect(Object.keys(wire.binding).sort()).toEqual([
      "memorySpaceId",
      "mode",
      "queryDigest",
      "scopeKey",
    ]);
    expect(M.decodeMemorySearchCursor(cursor, binding)).toBe(id(2));
    round(M.MemorySearchInput, { memorySpaceId: id(), query: "raw query", cursor });
    for (const change of [
      { queryDigest: "c".repeat(64) },
      { mode: "substring" as const },
      { memorySpaceId: M.MemorySpaceId.make(id(3)) },
      { scopeKey: "d".repeat(64) },
    ])
      expect(() => M.decodeMemorySearchCursor(cursor, { ...binding, ...change })).toThrow();
    for (const value of [id(2), "ms1:%broken", "ms2:bad", "{}"])
      rejects(M.MemorySearchInput, { memorySpaceId: id(), query: "query", cursor: value });
    const decoded = decode(M.MemorySearchCursor, {
      kind: "memory_search",
      version: 1,
      binding,
      afterMemoryId: id(2),
    });
    rejects(M.MemorySearchCursor, { ...decoded, query: "raw query" });
    rejects(M.MemorySearchCursor, { ...decoded, kind: "memory_list" });
    round(M.MemoryListInput, { memorySpaceId: id(), includeQuarantined: false, cursor: id(2) });
  });
  it("rejects overlong valid JSON cursors through public input and the direct helper", () => {
    const cursor = M.encodeMemorySearchCursor(binding, M.MemoryId.make(id(2)));
    const overlong =
      "ms1:" + encodeURIComponent(" ".repeat(1024) + decodeURIComponent(cursor.slice(4)));
    expect(Array.from(overlong).length).toBeGreaterThan(1024);
    expect(JSON.parse(decodeURIComponent(overlong.slice(4))).afterMemoryId).toBe(id(2));
    rejects(M.MemorySearchInput, { memorySpaceId: id(), query: "query", cursor: overlong });
    for (const value of [overlong, "ms1:%broken", "ms2:bad", ""])
      expect(() => M.decodeMemorySearchCursor(value, binding)).toThrow(
        expect.objectContaining({ code: "invalid_cursor" }),
      );
  });
  it("extends v1 normal responses and Boolean results with strict revoke arms", () => {
    const normal = round(M.MemoryHubSourceReadRespondInput, {
      protocolVersion: 1,
      memorySpaceId: id(),
      requestId: id(4),
      outcome: { kind: "denied", requiredPermission: "orchestration:read" },
    });
    expect(normal.kind).toBe("normal");
    if (normal.kind === "normal") expect(normal.ownerPolicyEpoch).toBe(0);
    const revoke = {
      protocolVersion: 1,
      memorySpaceId: id(),
      kind: "revoke",
      requesterEnvironmentId: "reader",
      ownerPolicyEpoch: 7,
    };
    round(M.MemoryHubSourceReadRespondInput, revoke);
    rejects(M.MemoryHubSourceReadRespondInput, { ...revoke, requestId: id(4) });
    rejects(M.MemoryHubSourceReadRespondInput, {
      ...revoke,
      outcome: normal.kind === "normal" ? normal.outcome : {},
    });
    rejects(M.MemoryHubSourceReadRespondInput, { ...revoke, ownerEnvironmentId: "forged" });
    rejects(M.MemoryHubSourceReadRespondInput, { ...revoke, protocolVersion: 2 });
    expect(round(M.MemoryHubSourceReadRespondResult, { accepted: true })).toEqual({
      kind: "normal",
      accepted: true,
    });
    round(M.MemoryHubSourceReadRespondResult, { kind: "revoke", accepted: true, ack });
    rejects(M.MemoryHubSourceReadRespondResult, { kind: "revoke", accepted: true });
    rejects(M.MemoryHubSourceReadRespondResult, { kind: "revoke", accepted: false, ack });
    rejects(M.MemorySourceReadRevokeAck, { ...ack, revokedThroughEpoch: 6 });
    rejects(M.MemorySourceReadRevokeAck, { ...ack, body: "forbidden" });
  });
  it("matches exact pending removal identities and epoch before opening enrollment", () => {
    const pending = { ...pair, state: "pending", removalEpoch: 7 };
    const typedAck = decode(M.MemorySourceReadRevokeAck, ack);
    const typedPending = decode(M.MemoryOwnerRemoval, pending);
    expect(M.matchesMemorySourceReadRevokeAck(typedPending, typedAck)).toBe(true);
    for (const change of [
      { memorySpaceId: M.MemorySpaceId.make(id(3)) },
      { ownerEnvironmentId: M.EnvironmentId.make("other") },
      { requesterEnvironmentId: M.EnvironmentId.make("other") },
      { removalEpoch: 6 },
    ])
      expect(M.matchesMemorySourceReadRevokeAck(typedPending, { ...typedAck, ...change })).toBe(
        false,
      );
    round(M.MemoryOwnerRemoval, { ...pending, state: "acknowledged", ack });
    rejects(M.MemoryOwnerRemoval, {
      ...pending,
      state: "acknowledged",
      ack: { ...ack, removalEpoch: 6 },
    });
    const blocked = {
      allowedRequesterEnvironmentIds: [],
      ownerPolicyEpoch: 8,
      removals: [pending],
      enrollments: [{ ...pair, state: "pending", removalEpoch: 7, ownerPolicyEpoch: 8 }],
    };
    round(M.MemoryOwnerSourceReadPolicy, blocked);
    rejects(M.MemoryOwnerSourceReadPolicy, {
      ...blocked,
      allowedRequesterEnvironmentIds: ["reader"],
    });
    rejects(M.MemoryOwnerSourceReadPolicy, {
      ...blocked,
      enrollments: [{ ...pair, state: "active", ownerPolicyEpoch: 8 }],
      allowedRequesterEnvironmentIds: ["reader"],
    });
    round(M.MemoryOwnerSourceReadPolicy, {
      ...blocked,
      removals: [{ ...pending, state: "acknowledged", ack }],
      enrollments: [{ ...pair, state: "active", ownerPolicyEpoch: 8 }],
      allowedRequesterEnvironmentIds: ["reader"],
    });
    rejects(M.MemoryOwnerSourceReadPolicy, {
      ...blocked,
      removals: [{ ...pending, state: "acknowledged", ack: { ...ack, revokedThroughEpoch: 9 } }],
      enrollments: [{ ...pair, state: "active", ownerPolicyEpoch: 8 }],
      allowedRequesterEnvironmentIds: ["reader"],
    });
    round(M.MemoryOwnerSourceReadPolicy, {
      ...blocked,
      ownerPolicyEpoch: 10,
      removals: [{ ...pending, state: "acknowledged", ack: { ...ack, revokedThroughEpoch: 9 } }],
      enrollments: [{ ...pair, state: "active", ownerPolicyEpoch: 10 }],
      allowedRequesterEnvironmentIds: ["reader"],
    });
    rejects(M.MemoryOwnerSourceReadPolicy, { ...blocked, removals: [pending, pending] });
    rejects(M.MemorySourceReadPairFences, [
      { ...pair, revokedThroughEpoch: 7 },
      { ...pair, revokedThroughEpoch: 8 },
    ]);
  });
  it("keeps admin authority and original request stamping outside public source input", () => {
    round(M.MemoryOwnerSourceReadPolicyUpdateInput, {
      requestId: id(),
      expectedVersion: 0,
      allowedRequesterEnvironmentIds: [],
    });
    rejects(M.MemoryOwnerSourceReadPolicyUpdateInput, {
      requestId: id(),
      expectedVersion: 0,
      allowedRequesterEnvironmentIds: [],
      ownerPolicyEpoch: 99,
    });
    round(M.MemoryHubDisableInput, { requestId: id(), expectedVersion: 0 });
    round(M.MemoryHubDisableResult, { settings: { mode: "disabled" }, version: 1 });
    rejects(M.MemoryHubDisableResult, {
      settings: { mode: "disabled" },
      version: 1,
      credential: "forged",
    });
    rejects(M.MemoryHubDisableInput, { requestId: id(), expectedVersion: 0, credential: "forged" });
    expect(M.MEMORY_MCP_TOOLS).toHaveLength(9);
    expect(M.MEMORY_ADMINISTRATION_MCP_TOOLS).toEqual([
      "memory_hub_disable",
      "memory_settings_get",
      "memory_settings_update",
    ]);
    round(M.MemorySettingsGetInput, {});
    round(M.MemorySettingsUpdateInput, { requestId: id(), enabled: false });
    round(M.MemorySettingsUpdateInput, { requestId: id(), modelSelection: null });
    rejects(M.MemorySettingsUpdateInput, { requestId: id() });
    round(M.MemorySourceReadStamp, {
      requesterCredentialVersion: 1,
      locatorDigest: "a".repeat(64),
    });
    rejects(M.MemorySourceReadStamp, {
      requesterCredentialVersion: 0,
      locatorDigest: "a".repeat(64),
    });
  });
});

describe("task memory grant ceiling JSON", () => {
  const codec = Schema.Struct({ memoryGrantCeiling: M.MemoryTaskGrantCeilingField });
  const json = Schema.fromJsonString(codec);
  it("omits missing and none while decoding both to none", () => {
    for (const input of [{}, { memoryGrantCeiling: "none" as const }]) {
      const encoded = Schema.encodeSync(json)(input);
      expect(JSON.parse(encoded)).not.toHaveProperty("memoryGrantCeiling");
      expect(Schema.decodeSync(json)(JSON.stringify(input))).toEqual({
        memoryGrantCeiling: "none",
      });
      expect(Schema.decodeSync(json)(encoded)).toEqual({ memoryGrantCeiling: "none" });
    }
  });
  it("preserves read and read_write in JSON", () => {
    for (const memoryGrantCeiling of ["read", "read_write"] as const) {
      const encoded = Schema.encodeSync(json)({ memoryGrantCeiling });
      expect(JSON.parse(encoded)).toHaveProperty("memoryGrantCeiling", memoryGrantCeiling);
      expect(Schema.decodeSync(json)(encoded)).toEqual({ memoryGrantCeiling });
    }
  });
});

describe("hub settings roster boundary", () => {
  const member = {
    environmentId: "device",
    credentialVersion: 1,
    status: "pending_ack",
    joinedAt: 0,
  };
  const view = { settings: { mode: "hub", memorySpaceId: id() }, version: 2, members: [member] };
  it("bounds and validates the live roster without accepting credential metadata", () => {
    round(M.MemoryHubSettingsView, view);
    for (const status of ["active"])
      round(M.MemoryHubSettingsView, { ...view, members: [{ ...member, status }] });
    round(M.MemoryHubSettingsView, {
      ...view,
      members: Array.from({ length: M.MEMORY_HUB_MAX_MEMBERS }, (_, n) => ({
        ...member,
        environmentId: `device-${n}`,
      })),
    });
    rejects(M.MemoryHubSettingsView, {
      ...view,
      members: Array.from({ length: M.MEMORY_HUB_MAX_MEMBERS + 1 }, (_, n) => ({
        ...member,
        environmentId: `device-${n}`,
      })),
    });
    rejects(M.MemoryHubSettingsView, { ...view, members: [member, member] });
    for (const field of ["credential", "credentialDigest", "secretName", "endpoint"])
      rejects(M.MemoryHubSettingsView, { ...view, members: [{ ...member, [field]: "forged" }] });
    for (const patch of [{ credentialVersion: 0 }, { status: "revoked" }, { joinedAt: -1 }])
      rejects(M.MemoryHubSettingsView, { ...view, members: [{ ...member, ...patch }] });
    for (const settings of [
      { mode: "disabled" },
      { mode: "hub", memorySpaceId: null },
      {
        mode: "member",
        hubEnvironmentId: "hub",
        endpoint: "https://hub.example",
        secretName: "synthetic",
        memorySpaceId: id(),
      },
    ]) {
      round(M.MemoryHubSettingsView, { ...view, settings, members: [] });
      rejects(M.MemoryHubSettingsView, { ...view, settings });
    }
    rejects(M.MemoryHubDisableResult, { settings: { mode: "disabled" }, version: 1, members: [] });
  });
});

it("r5 bounds upsert request identity and exposes incomplete provenance guidance", () => {
  expect(() =>
    decode(M.MemoryProvenance, { environmentId: "env", upsertRequestDigest: "x" }),
  ).toThrow();
  expect(
    decode(M.MemoryProvenance, { environmentId: "env", upsertRequestDigest: "a".repeat(64) })
      .upsertRequestDigest,
  ).toBe("a".repeat(64));
  const guidance =
    "This conversation has incomplete memory provenance and cannot save new memories. Start a new conversation to save this memory.";
  const error = new M.MemoryRpcError({ code: "thread_lineage_incomplete", guidance });
  expect(Schema.encodeSync(M.MemoryRpcError)(error)).toMatchObject({
    code: "thread_lineage_incomplete",
    guidance,
  });
  expect(error.message).toBe(guidance);
  expect(() =>
    decode(M.MemoryRpcError, {
      _tag: "MemoryRpcError",
      code: "thread_lineage_incomplete",
      guidance: "arbitrary",
    }),
  ).toThrow();
});

describe("resolution input history selection", () => {
  const input = { memorySpaceId: id(), memoryId: id(2), resolutionInputsFor: id(7), limit: 20 };
  it("round-trips one resolution selector with bounded pagination", () => {
    round(M.MemoryHistoryInput, input);
    round(M.MemoryHistoryInput, { ...input, cursor: "20", limit: 100 });
    round(M.MemoryHistoryInput, { memorySpaceId: id(), memoryId: id(2), limit: 20 });
  });
  it("rejects invalid IDs, plural selectors and page limits outside the contract", () => {
    for (const resolutionInputsFor of [null, "invalid", [id(7)]])
      rejects(M.MemoryHistoryInput, { ...input, resolutionInputsFor });
    for (const limit of [0, -1, 101, 1.5]) rejects(M.MemoryHistoryInput, { ...input, limit });
    rejects(M.MemoryHistoryInput, { ...input, resolutionIds: [id(7)] });
  });
});

it("keeps restoration availability bounded to visible revisions in the selected page", () => {
  round(M.MemoryHistoryPage, { ...history, restorableRevisionIds: [revision.revisionId] });
  rejects(M.MemoryHistoryPage, { ...history, restorableRevisionIds: [id(9999)] });
  rejects(M.MemoryHistoryPage, {
    ...history,
    restorableRevisionIds: [revision.revisionId, revision.revisionId],
  });
  rejects(M.MemoryHistoryPage, {
    ...history,
    revisions: [{ revision, payload: null }],
    restorableRevisionIds: [revision.revisionId],
    localAvailability: {
      exposure: "held",
      reasons: ["secret_detected"],
      deferred: [],
      cleanupPending: false,
    },
  });
});

describe("WP5 lineage checkpoint contracts", () => {
  const source = {
    memorySpaceId: id(),
    memoryId: id(2),
    kind: "sourceKey",
    sourceKey: { environmentId: "env", sourceId: id(10), sourceItemKey: "entry" },
  };
  const content = {
    memorySpaceId: id(),
    memoryId: id(2),
    kind: "content",
    content: {
      scope: { kind: "user" },
      assertionKind: "inference",
      contentFingerprint: "a".repeat(64),
    },
  };
  it("round-trips both body-free lineage arms in a v1 checkpoint", () => {
    for (const row of [source, content]) round(M.MemoryImportLineageRecord, row);
    const page = round(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      importLineage: [source, content],
    });
    expect(M.validateMemoryCheckpointRecords([page])).toBe(true);
    expect(M.MEMORY_PROTOCOL_VERSION).toBe(1);
    expect(M.MEMORY_IMPORT_LINEAGE_MAX_RECORDS_PER_MEMORY).toBe(1000);
    expect(M.MEMORY_IMPORT_LINEAGE_MAX_BYTES).toBe(33554432);
  });
  it("strictly rejects missing required checkpoint lineage", () => {
    const { importLineage: _lineage, ...oldPage } = checkpoint;
    rejects(M.MemoryHubCheckpointPage, oldPage);
    expect(() => M.MemoryHubCheckpointPage.make(oldPage as never)).toThrow();
    expect(M.validateMemoryCheckpointRecords([oldPage as never])).toBe(false);
    rejects(M.MemoryHubCheckpointPage, { ...checkpoint, importLineage: null });
  });
  it("rejects unknown lineage kinds, missing arms, mixed arms and suppression fields", () => {
    for (const bad of [
      { ...source, kind: "unknown" },
      { memorySpaceId: id(), memoryId: id(2), kind: "sourceKey" },
      { memorySpaceId: id(), memoryId: id(2), kind: "content" },
      { ...source, content: content.content },
      { ...source, deleteOperationId: id(4) },
      { ...content, body: "forbidden" },
      { ...source, sourceKey: { ...source.sourceKey, path: "/private" } },
    ]) {
      rejects(M.MemoryImportLineageRecord, bad);
      expect(() => M.MemoryImportLineageRecord.make(bad as never)).toThrow();
    }
  });
  it("counts lineage in the mixed 100-record page envelope", () => {
    const rows = Array.from({ length: 97 }, (_, n) => ({
      ...source,
      sourceKey: { ...source.sourceKey, sourceItemKey: `key:${n}` },
    }));
    round(M.MemoryHubCheckpointPage, { ...checkpoint, importLineage: rows });
    rejects(M.MemoryHubCheckpointPage, { ...checkpoint, importLineage: [...rows, content] });
  });
  it("charges escaped lineage encoding to the existing page byte envelope", () => {
    const rows = Array.from({ length: 97 }, (_, n) => ({
      ...source,
      sourceKey: { ...source.sourceKey, sourceItemKey: `${n}${"\u0001".repeat(500)}` },
    }));
    expect(
      new TextEncoder().encode(JSON.stringify({ ...checkpoint, importLineage: rows })).length,
    ).toBeGreaterThan(262144);
    rejects(M.MemoryHubCheckpointPage, { ...checkpoint, importLineage: rows });
  });
  it("validates identity, space and content scope across pages and canonical duplicates", () => {
    const page = (rows: unknown[]) =>
      decode(M.MemoryHubCheckpointPage, { ...checkpoint, importLineage: rows });
    for (const rows of [
      [{ ...source, memoryId: id(99) }],
      [{ ...source, memorySpaceId: id(99) }],
      [
        {
          ...content,
          content: {
            ...content.content,
            scope: { kind: "project", projectKey: { kind: "repository", groupingKey: "other" } },
          },
        },
      ],
      [
        source,
        {
          ...source,
          sourceKey: { sourceItemKey: "entry", sourceId: id(10), environmentId: "env" },
        },
      ],
    ])
      expect(M.validateMemoryCheckpointRecords([page(rows)])).toBe(false);
    const first = decode(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      importLineage: [source],
      nextCursor: "next",
      bootstrapComplete: false,
    });
    const second = decode(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      pageOrdinal: 1,
      identities: [],
      fences: [],
      compactReceipts: [],
      importLineage: [content],
    });
    expect(M.validateMemoryCheckpointRecords([first, second])).toBe(true);
    expect(
      M.validateMemoryCheckpointRecords([first, { ...second, importLineage: first.importLineage }]),
    ).toBe(false);
    const typed = decode(M.MemoryImportLineageRecord, source);
    expect(M.memoryImportLineageRecordKey(typed)).toBe(
      M.memoryImportLineageRecordKey({
        ...typed,
        ...decode(M.MemoryImportLineageRecord, {
          ...source,
          sourceKey: { sourceItemKey: "entry", sourceId: id(10), environmentId: "env" },
        }),
      }),
    );
  });
  it("keeps canonical lineage keys stable through sorting and multi-page pagination", () => {
    const rows = Array.from({ length: 151 }, (_, n) =>
      decode(M.MemoryImportLineageRecord, {
        ...source,
        sourceKey: { ...source.sourceKey, sourceItemKey: `key:${n}` },
      }),
    );
    const ordered = [...rows].sort((a, b) =>
      M.memoryImportLineageRecordKey(a) < M.memoryImportLineageRecordKey(b) ? -1 : 1,
    );
    const first = decode(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      importLineage: ordered.slice(0, 97),
      nextCursor: "next",
      bootstrapComplete: false,
    });
    const second = decode(M.MemoryHubCheckpointPage, {
      ...checkpoint,
      identities: [],
      compactReceipts: [],
      fences: [],
      pageOrdinal: 1,
      importLineage: ordered.slice(97),
    });
    expect(M.validateMemoryCheckpointRecords([first, second])).toBe(true);
    expect(
      [first, second].flatMap((p) => p.importLineage).map(M.memoryImportLineageRecordKey),
    ).toEqual(ordered.map(M.memoryImportLineageRecordKey));
    const reordered = decode(M.MemoryImportLineageRecord, {
      ...content,
      content: {
        contentFingerprint: content.content.contentFingerprint,
        assertionKind: "inference",
        scope: { kind: "user" },
      },
    });
    expect(M.memoryImportLineageRecordKey(reordered)).toBe(
      M.memoryImportLineageRecordKey(decode(M.MemoryImportLineageRecord, content)),
    );
  });
  it("appends capacity ordinals and carries lineage capacities through existing import errors/results", () => {
    const old = [
      "body",
      "user_items",
      "project_items",
      "thread_summaries",
      "thread_items",
      "space_live_items",
      "environment_live_items",
      "live_payload_bytes",
      "history",
      "import_session_items",
      "import_session_bytes",
      "import_live_items",
      "import_live_bytes",
      "import_source_items",
      "import_aliases",
      "import_digests",
      "permanent_metadata",
      "lifetime_ids",
      "receipts",
      "log_tail_rows",
      "log_tail_bytes",
      "work_items",
      "work_bytes",
      "report_items",
      "report_bytes",
      "relay_environment",
      "relay_hub",
      "members",
      "checkpoint_handles",
      "checkpoint_staging",
      "derived_cache",
      "fts_indexed_text",
      "fts_admission_brake",
    ];
    expect(M.MemoryCapacityDimension.literals).toEqual([
      ...old,
      "import_lineage_records",
      "import_lineage_bytes",
    ]);
    for (const dimension of M.MemoryCapacityDimension.literals) {
      const capacity = {
        code: "capacity_exceeded",
        dimension,
        current: 1000,
        limit: 1000,
        reclaimable: 0,
      };
      round(M.MemoryCapacityExceeded, capacity);
      round(M.MemoryImportRpcError, {
        _tag: "MemoryImportRpcError",
        issue: "capacity_exceeded",
        capacity,
      });
      round(M.MemoryImportItemResult, {
        sourceItemKey: "entry",
        outcome: "rejected",
        issue: "capacity_exceeded",
        capacity,
        memoryId: null,
        revisionId: null,
      });
      rejects(M.MemoryCapacityExceeded, { ...capacity, current: -1 });
      rejects(M.MemoryCapacityExceeded, { ...capacity, limit: 0 });
      rejects(M.MemoryCapacityExceeded, { ...capacity, reclaimable: -1 });
      rejects(M.MemoryCapacityExceeded, { ...capacity, extra: true });
    }
    rejects(M.MemoryCapacityExceeded, {
      code: "capacity_exceeded",
      dimension: "unknown",
      current: 0,
      limit: 1,
      reclaimable: 0,
    });
  });
});

it("report retry reset accepts at most 32 distinct exact-owner IDs and rejects excess fields", () => {
  const valid = {
    memorySpaceId: id(),
    environmentId: "fixture",
    reportIds: Array.from({ length: 32 }, (_, n) => n.toString(16).padStart(64, "0")),
  };
  const decode = Schema.decodeUnknownSync(M.MemoryResetReportAttemptsInput);
  expect(decode(valid).reportIds).toHaveLength(32);
  for (const invalid of [
    { ...valid, reportIds: [...valid.reportIds, "f".repeat(64)] },
    { ...valid, reportIds: [valid.reportIds[0], valid.reportIds[0]] },
    { ...valid, reportIds: [] },
    { ...valid, agent: true },
    { ...valid, environmentId: undefined },
  ])
    expect(() => decode(invalid)).toThrow();
  expect(() =>
    Schema.decodeSync(M.MemoryResetReportAttemptsResult)({
      resetCount: 33,
      unchangedCount: 0,
    }),
  ).toThrow();
});

it("refused revert results are body-free and history opt-in is explicit", () => {
  const result = {
    operationId: id(80),
    memoryId: id(2),
    resolutionId: id(7),
    revertDeadlineUtc: resolution.revertDeadlineUtc,
    status: "refused",
    failureCode: "unavailable",
  };
  round(M.MemoryRevertResult, result);
  round(M.MemoryHistoryPage, { ...history, revertResults: [result] });
  rejects(M.MemoryRevertResult, { ...result, failureCode: "raw-private-error" });
  rejects(M.MemoryRevertResult, { ...result, body: "private" });
  rejects(M.MemoryRevertResult, { ...result, failureCode: undefined });
  round(M.MemoryHistoryInput, { memorySpaceId: id(), memoryId: id(2), limit: 10 });
  round(M.MemoryHistoryInput, {
    memorySpaceId: id(),
    memoryId: id(2),
    limit: 10,
    includeRefusedReverts: true,
  });
  rejects(M.MemoryHistoryInput, {
    memorySpaceId: id(),
    memoryId: id(2),
    limit: 10,
    includeRefusedReverts: false,
  });
});

it("strictly bounds hub diagnostics and rejects unsafe or duplicated reasons", () => {
  const diagnostic = {
    version: 1,
    publication: { state: "current" },
    readiness: "ready",
    connection: "unreachable",
    recoverableHolds: ["protocol", "availability"],
    permanentHolds: ["identity", "authorization"],
    reconcile: "permanent_hold",
  };
  const decode = Schema.decodeUnknownSync(M.MemoryHubDiagnostics);
  expect(decode(diagnostic)).toEqual(diagnostic);
  for (const invalid of [
    { ...diagnostic, reason: "raw endpoint or credential" },
    { ...diagnostic, permanentHolds: ["identity", "identity"] },
    { ...diagnostic, recoverableHolds: ["authorization"] },
    { ...diagnostic, publication: { state: "last_valid", code: "raw exception" } },
    { ...diagnostic, version: -1 },
  ])
    expect(() => decode(invalid)).toThrow();
  const request = { memorySpaceId: id(), environmentId: "fixture", expectedVersion: 1 };
  expect(Schema.decodeSync(M.MemoryHubReconcileInput)(request)).toEqual(request);
  expect(() =>
    Schema.decodeUnknownSync(M.MemoryHubReconcileInput)({ ...request, releaseAll: true }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(M.MemoryHubReconcileResult)({
      version: 1,
      rearmedClasses: ["identity"],
    }),
  ).toThrow();
});

it("opts into retained local space without changing legacy sync status requests", () => {
  round(M.MemorySyncStatusInput, {});
  round(M.MemorySyncStatusInput, { includeRetainedLocalSpaceId: true });
  rejects(M.MemorySyncStatusInput, { includeRetainedLocalSpaceId: false });
  rejects(M.MemorySyncStatusInput, { includeRetainedLocalSpaceId: null });
  round(M.MemorySyncStatusInput, { includeGenerationHold: true });
  round(M.MemorySyncStatusInput, {
    includeRetainedLocalSpaceId: true,
    includeGenerationHold: true,
  });
  rejects(M.MemorySyncStatusInput, { includeGenerationHold: false });
  rejects(M.MemorySyncStatusInput, { includeGenerationHold: true, extra: true });
});

// Frozen outer response shapes from origin/dev before automatic hub initialization.
// Nested settings/member/credential contracts are unchanged by this feature.
const legacyHubSnapshot = Schema.Struct({
  settings: M.MemoryHubSettings,
  version: M.NonNegativeInt,
});
const legacyHubView = Schema.Struct({
  ...legacyHubSnapshot.fields,
  members: Schema.Array(M.MemoryHubMemberView),
});
const legacyHubUpdate = Schema.Struct({
  view: legacyHubView,
  credential: Schema.NullOr(M.MemoryHubCredentialResult),
});
const legacyHubDisable = legacyHubSnapshot.check(
  Schema.makeFilter((view) => view.settings.mode === "disabled"),
);
const compatible = <A, I>(
  current: Schema.Codec<A, I>,
  legacy: Schema.Codec<A, I>,
  response: unknown,
) => {
  const strict = { onExcessProperty: "error" } as const;
  const oldResponse = Schema.encodeSync(legacy)(Schema.decodeUnknownSync(legacy)(response, strict));
  // A new client can read an old server's response with exactly the same encoded keys.
  const decoded = Schema.decodeUnknownSync(current)(oldResponse, strict);
  const newResponse = Schema.encodeSync(current)(decoded);
  expect(newResponse).toEqual(oldResponse);
  // An installed old client can read the new server's response without extra properties.
  expect(Schema.decodeUnknownSync(legacy)(newResponse, strict)).toEqual(decoded);
};
it.each([
  { mode: "disabled" },
  { mode: "hub", memorySpaceId: id() },
  { mode: "hub", memorySpaceId: null },
  {
    mode: "member",
    hubEnvironmentId: "remote",
    endpoint: "https://fixture.example",
    memorySpaceId: id(),
    secretName: "fixture",
  },
])("keeps settings-get and settings-update compatible in both directions for $mode", (settings) => {
  const view = { settings, version: 1, members: [] };
  compatible(M.MemoryHubSettingsView, legacyHubView, view);
  compatible(M.MemoryHubSettingsUpdateResult, legacyHubUpdate, { view, credential: null });
});
it("keeps disable compatible in both directions without even null provenance", () => {
  const response = { settings: { mode: "disabled" }, version: 1 };
  compatible(M.MemoryHubDisableResult, legacyHubDisable, response);
  expect(() =>
    Schema.decodeUnknownSync(legacyHubDisable)(
      { ...response, provenance: null },
      { onExcessProperty: "error" },
    ),
  ).toThrow();
});
