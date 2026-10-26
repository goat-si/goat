import { encodeCheckpointPage } from "../MemoryCheckpointInventory.ts";
import * as NodeUtil from "node:util";
import * as M from "@goat/contracts";
import { MemoryRevertSlot } from "../MemoryRevertSlot.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlError } from "effect/sql/SqlError";
import {
  AdminRecordSchema,
  AdminReplaySchema,
  DeferredRow,
  FtsState,
  HoldClass,
  HubCheckpointHandleSchema,
  LocalIntentMetadata,
  LocalMemoryIntent,
  MemoryStorageError,
  MemoryWork,
  Metadata,
  PendingForgetIntent,
  PersistedAdminActionSchema,
  PullRetry,
  Receipt,
  StoredTicketRowSchema,
  ThreadHookMetadata,
  ThreadLineageMetadata,
  WorkMetadata,
  digest,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { AdminRecord, HoldRearmPage } from "./StoreModel.ts";

export type HistoryRevisionRow = {
  revision_id: string;
  operation_id: string;
  parents_json: string;
  scope_json: string;
  assertion_kind: string;
  provenance_json: string;
  payload_ref: string | null;
  created_at: number;
  body_json: string | null;
};

// All JSON goes through Effect codecs, including values reconstructed from SQL rows.
export const codec = <S extends Schema.Constraint>(schema: S) => {
  const json = Schema.fromJsonString(schema);
  const encode = Schema.encodeEffect(json);
  const decode = Schema.decodeUnknownEffect(json);
  return {
    encode: (value: S["Type"]) => stored("encode", encode(value)),
    decode: (value: unknown, options?: typeof strict) => stored("decode", decode(value, options)),
  };
};
export const decodeFailureCode = Schema.decodeUnknownEffect(M.MemoryFailureCode);
export const decodeHoldClass = Schema.decodeUnknownEffect(HoldClass);
export const pullRetryCodec = codec(PullRetry);
export const resolutionReasonsCodec = codec(Schema.Array(M.MemoryDeferredReason));
export const hubReceiptCodec = codec(M.MemoryHubReceipt);
export const decodeFailureEnvironment = Schema.decodeUnknownEffect(M.EnvironmentId);
export const threadHookCodec = codec(ThreadHookMetadata);
export const threadLineageCodec = codec(ThreadLineageMetadata);
export const deferredRowCodec = codec(DeferredRow);
export const decodeLocalIntent = Schema.decodeUnknownEffect(LocalMemoryIntent);
export const localMetadataCodec = codec(LocalIntentMetadata);
export const decodeTicket = Schema.decodeUnknownEffect(M.MemoryResolutionLease);
export const decodeReport = Schema.decodeUnknownEffect(M.MemoryReportDelivery);
export const decodeRevertResult = Schema.decodeUnknownEffect(M.MemoryRevertResult);
export const revertSlotCodec = codec(MemoryRevertSlot);
export const threadCodec = codec(M.ScopedThreadRef);
export const decodeCheckpoint = Schema.decodeUnknownEffect(M.MemoryHubCheckpointPage);
export const checkpointCodec = {
  ...codec(M.MemoryHubCheckpointPage),
  encode: (page: M.MemoryHubCheckpointPage) =>
    stored("checkpoint-encode", encodeCheckpointPage(page)),
};
export const importId = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const importKey = Schema.String.check(
  Schema.makeFilter(
    (s) =>
      s.length > 0 &&
      new TextEncoder().encode(s).length <= 512 &&
      !Array.from(s).some((c) => c.charCodeAt(0) < 32),
  ),
);
const importLabel = Schema.String.check(
  Schema.makeFilter((s) => s.length > 0 && new TextEncoder().encode(s).length <= 512),
);
const importCount = Schema.Int.check(Schema.makeFilter((n) => n >= 0));
const importAddress = { memorySpaceId: M.MemorySpaceId, environmentId: M.EnvironmentId };
const importSourceAddress = { ...importAddress, sourceId: M.MemoryImportSourceId };
export const importDigestsCodec = codec(Schema.Array(digest));
const ImportSlotCodec = Schema.Struct({
  format: M.MemoryImportSourceFormat,
  rootSlot: importKey,
  selection: Schema.NullOr(importKey),
});
const ImportSessionCodec = Schema.Struct({
  sessionId: importLabel,
  parserVersion: importLabel,
  profile: importLabel,
  snapshotDigest: digest,
  createdAtUtc: M.MemoryUtcTimestamp,
  expiresAtUtc: M.MemoryUtcTimestamp,
  newItems: importCount,
  bodyBytes: importCount,
  applied: Schema.Array(
    Schema.Struct({ sourceItemKey: importKey, sourceFingerprint: digest, bodyBytes: importCount }),
  ),
});
const ImportRegistrationCodec = Schema.Struct({
  ...importSourceAddress,
  codecVersion: Schema.Literal(1),
  version: importCount,
  slot: ImportSlotCodec,
  source: M.MemoryImportSource,
  sourceLocator: importLabel.check(
    Schema.makeFilter((s) => !s.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(s)),
  ),
  session: Schema.NullOr(ImportSessionCodec),
}).check(
  Schema.makeFilter((r) => r.sourceId === r.source.sourceId && r.slot.format === r.source.format),
);
const ImportSelectorCodec = Schema.Struct({
  sourceItemKey: importKey,
  sourceFingerprint: digest,
  scope: M.MemoryScope,
  project: Schema.optionalKey(M.ScopedProjectRef),
});
const ImportObservationCodec = Schema.Struct({
  sourceFingerprint: digest,
  contentFingerprint: digest,
  revisionId: M.MemoryRevisionId,
  operationId: M.MemoryOperationId,
});
export const ImportBatchCodec = Schema.Struct({
  ...importAddress,
  operationId: M.MemoryOperationId,
  kind: Schema.Literal("detailed"),
  codecVersion: Schema.Literal(1),
  selectionDigest: digest,
  sourceId: M.MemoryImportSourceId,
  sessionId: importLabel,
  selections: Schema.Array(
    Schema.Struct({
      observation: Schema.optionalKey(ImportObservationCodec),
      settled: Schema.optionalKey(Schema.Boolean),
      selector: ImportSelectorCodec,
      memoryId: M.MemoryId,
      operationId: M.MemoryOperationId,
      revisionId: M.MemoryRevisionId,
      result: Schema.NullOr(M.MemoryImportItemResult),
    }),
  ),
  receipt: M.MemoryImportReceipt,
  createdAtUtc: M.MemoryUtcTimestamp,
}).check(
  Schema.makeFilter(
    (b) =>
      b.selections.length > 0 &&
      b.selections.length <= M.MEMORY_IMPORT_APPLY_MAX_ITEMS &&
      new Set(b.selections.map((s) => s.selector.sourceItemKey)).size === b.selections.length &&
      new Set(b.selections.map((s) => s.operationId)).size === b.selections.length &&
      new Set(b.selections.map((s) => s.revisionId)).size === b.selections.length &&
      b.receipt.operationId === b.operationId &&
      b.receipt.sourceId === b.sourceId &&
      b.receipt.sessionId === b.sessionId &&
      b.receipt.remaining === b.selections.filter((s) => s.result === null).length &&
      NodeUtil.isDeepStrictEqual(
        b.receipt.items,
        b.selections.flatMap((s) => (s.result ? [s.result] : [])),
      ) &&
      b.selections.every(
        (s) =>
          s.result === null ||
          (s.result.sourceItemKey === s.selector.sourceItemKey &&
            (s.result.memoryId === null || s.result.memoryId === s.memoryId) &&
            (s.result.revisionId === null ||
              s.result.outcome === "noop" ||
              s.result.revisionId === s.observation?.revisionId ||
              s.result.revisionId === s.revisionId)),
      ),
  ),
);
// Only fully settled noop results may leave the mutable detailed settlement path.
export const ImportCompletedNoopCodec = Schema.Struct({
  ...importSourceAddress,
  kind: Schema.Literal("completed-noop-ref"),
  codecVersion: Schema.Literal(1),
  operationId: M.MemoryOperationId,
  selectionDigest: digest,
  sessionId: importLabel.check(Schema.makeFilter((s) => new TextEncoder().encode(s).length <= 64)),
  resultRef: digest,
  sessionNewItems: importCount,
  sessionBodyBytes: importCount,
  createdAtUtc: M.MemoryUtcTimestamp,
});
export const ImportNoopResultCodec = Schema.Struct({
  codecVersion: Schema.Literal(1),
  items: Schema.Array(M.MemoryImportItemResult).check(
    Schema.makeFilter(
      (items) =>
        items.length > 0 &&
        items.length <= M.MEMORY_IMPORT_APPLY_MAX_ITEMS &&
        items.every((i) => i.outcome === "noop"),
    ),
  ),
});
const ImportRetiredCodec = Schema.Struct({
  kind: Schema.Literal("retired"),
  codecVersion: Schema.Literal(1),
  selectionDigest: digest,
});
const ImportItemCodec = Schema.Struct({
  ...importSourceAddress,
  codecVersion: Schema.Literal(1),
  sourceItemKey: importKey,
  scope: M.MemoryScope,
  memoryId: M.MemoryId,
  accepted: Schema.NullOr(ImportObservationCodec),
  pending: Schema.NullOr(ImportObservationCodec),
  rejected: Schema.NullOr(Schema.Struct({ sourceFingerprint: digest, issue: M.MemoryImportIssue })),
  outcome: M.MemoryImportOutcome,
});
const privateImportCodec = <S extends Schema.Constraint>(schema: S) => {
  const c = codec(schema);
  return {
    ...c,
    encode: (value: S["Type"]) =>
      stored("import-codec", Schema.decodeUnknownEffect(schema)(value, strict)).pipe(
        Effect.flatMap(c.encode),
      ),
  };
};
export const importRegistrationCodec = privateImportCodec(ImportRegistrationCodec);
export const importBatchCodec = privateImportCodec(
  Schema.Union([ImportBatchCodec, ImportCompletedNoopCodec, ImportRetiredCodec]),
);
export const importNoopResultCodec = privateImportCodec(ImportNoopResultCodec);
export const importItemCodec = privateImportCodec(ImportItemCodec);
export const lineageCodec = codec(M.MemoryImportLineageRecord);
export const stagedCheckpointCodec = codec(
  Schema.Struct({
    page: M.MemoryHubCheckpointPage,
    heads: Schema.Array(
      Schema.Struct({ memoryId: M.MemoryId, heads: Schema.Array(M.MemoryRevisionId) }),
    ),
  }),
);
export const environmentOrdinalCodec = codec(Schema.Int.check(Schema.makeFilter((n) => n > 0)));
export const compactCodec = codec(M.MemoryCompactReceipt);
export const boundaryCodec = codec(M.MemoryCausalBoundary);
export const suppressionKeyCodec = codec(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("sourceKey"), value: M.MemorySourceKey }),
    Schema.Struct({ kind: Schema.Literal("content"), value: M.MemoryContentSuppression }),
    Schema.Struct({ kind: Schema.Literal("sourceExclusion"), value: M.MemorySourceExclusion }),
  ]),
);
export const metadataCodec = codec(Metadata);
export const workMetadataCodec = codec(WorkMetadata);
export const receiptCodec = codec(Receipt);
const Projection = Schema.Union([
  Schema.Struct({
    memorySpaceId: M.MemorySpaceId,
    memoryId: M.MemoryId,
    pendingSync: Schema.Boolean,
    localAvailability: M.MemoryLocalAvailability,
    status: Schema.Literal("active"),
    scope: M.MemoryScope,
    revision: M.MemoryRevision,
  }),
  M.MemoryItem.check(Schema.makeFilter((item) => item.status !== "active")),
]);
export const projectionCodec = codec(Projection);
export const decodeItem = Schema.decodeUnknownEffect(M.MemoryItem);
export const encodeSearchItem = Schema.encodeEffect(Schema.fromJsonString(M.MemoryItem));
export const payloadCodec = codec(M.MemoryPayload);
export const resolutionPayloadCodec = codec(M.MemoryResolutionPayload);
export const scopeCodec = codec(M.MemoryScope);
export const headsCodec = codec(Schema.Array(M.MemoryRevisionId));
export const provenanceCodec = codec(M.MemoryProvenance);
export const availabilityCodec = codec(M.MemoryLocalAvailability);
export const deferredCodec = codec(Schema.Array(DeferredRow));
export const identityCodec = codec(M.MemoryIdentityRecord);
export const fenceCodec = codec(M.MemoryFenceRecord);
export const rulesCodec = codec(
  Schema.Array(Schema.String).check(
    Schema.makeFilter(
      (values) => values.length <= 64 && values.every((value) => value.length <= 128),
    ),
  ),
);
export const sourceKeysCodec = codec(Schema.Array(M.MemorySourceKey));
export const contentCodec = codec(Schema.Array(M.MemoryContentSuppression));
export const exclusionsCodec = codec(Schema.Array(M.MemorySourceExclusion));
export const selectionCodec = codec(M.MemoryModelSelection);
export const executionCodec = codec(M.MemoryGenerationExecution);
export const resolutionCodec = codec(M.MemoryResolution);
export const sampleCodec = codec(M.MemoryStorageSample);
export const keyCodec = codec(M.MemoryProjectKey);
export const decodeOperation = Schema.decodeUnknownEffect(M.MemoryOperation);
export const decodeWork = Schema.decodeUnknownEffect(MemoryWork);
export const decodePendingForget = Schema.decodeUnknownEffect(PendingForgetIntent);
export const decodeBinding = Schema.decodeUnknownEffect(M.MemoryProjectBinding);
export const decodeTombstone = Schema.decodeUnknownEffect(M.MemoryTombstone);
export const decodeConflict = Schema.decodeUnknownEffect(M.MemoryConflict);
export const decodeRevision = Schema.decodeUnknownEffect(M.MemoryRevision);
export const isSqlError = Schema.is(SqlError);
export const decodeMemoryId = Schema.decodeUnknownEffect(M.MemoryId);
export const decodeMemorySpaceId = Schema.decodeUnknownEffect(M.MemorySpaceId);
export const decodeAssertionKind = Schema.decodeUnknownEffect(M.MemoryAssertionKind);
export const decodeReceipt = Schema.decodeUnknownEffect(Receipt);
export const decodeFtsState = Schema.decodeUnknownEffect(FtsState);
export const suppressionCodec = codec(M.MemorySuppressionRecord);
export const decodeScope = Schema.decodeUnknownEffect(M.MemoryScope);
export const stored = <A, E, R>(stage: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new MemoryStorageError({ stage, cause })));
export const scopeKey = (scope: M.MemoryScope) => {
  if (scope.kind === "user") return "user";
  if (scope.kind === "thread")
    return `thread:${scope.thread.environmentId.length}:${scope.thread.environmentId}:${scope.thread.threadId}`;
  return scope.projectKey.kind === "repository"
    ? `repository:${scope.projectKey.groupingKey}`
    : `explicit:${scope.projectKey.sharedProjectId}`;
};
export const metadataOf = (operation: M.MemoryOperation): typeof Metadata.Type => {
  if (operation.kind === "forget") return operation;
  const { payload: _payload, ...metadata } = operation;
  if (metadata.kind === "resolve") {
    const { resolutionPayload: _judgment, ...safe } = metadata;
    return safe;
  }
  return metadata;
};

export const lineageForRevision = (
  revision: M.MemoryRevision,
): readonly M.MemoryImportLineageRecord[] => {
  const source = revision.provenance.importSource;
  if (!source) return [];
  const base = { memorySpaceId: revision.memorySpaceId, memoryId: revision.memoryId };
  return [
    ...[
      {
        environmentId: revision.provenance.environmentId,
        sourceId: source.sourceId,
        sourceItemKey: source.sourceItemKey,
      },
      ...source.sourceAliases,
    ].map((sourceKey) => ({ ...base, kind: "sourceKey" as const, sourceKey })),
    ...[source.contentFingerprint, ...source.acceptedContentFingerprints].map(
      (contentFingerprint) => ({
        ...base,
        kind: "content" as const,
        content: {
          scope: revision.scope,
          assertionKind: revision.assertionKind,
          contentFingerprint,
        },
      }),
    ),
  ];
};

export const importTime = (ms: number) =>
  Effect.succeed(DateTime.formatIso(DateTime.makeUnsafe(ms)));

// oxlint-disable-next-line goat/prefer-effect-fn -- Moved verbatim from the MemoryStore closure; adding a span here would change tracing.
export const decodeHistoryRevision = (
  row: HistoryRevisionRow,
  space: M.MemorySpaceId,
  id: M.MemoryId,
  visible: boolean,
) =>
  Effect.gen(function* () {
    const revision = yield* stored(
      "revision-codec",
      decodeRevision(
        {
          memorySpaceId: space,
          memoryId: id,
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
      payload:
        row.body_json && visible
          ? yield* stored("payload-codec", payloadCodec.decode(row.body_json, strict))
          : null,
    };
  });
export const workRows = Effect.fnUntraced(function* (
  rows: ReadonlyArray<{
    id: string;
    space: string;
    memory_id: string | null;
    kind: string;
    status: string;
    metadata_json: string;
    payload_ref: string | null;
    attempt: number;
    next_attempt_at: number;
    claimed_by: string | null;
    claimed_until: number | null;
    sync_version?: number;
  }>,
) {
  return yield* stored(
    "work-codec",
    Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const decodedMetadata = yield* workMetadataCodec.decode(row.metadata_json, strict);
        return yield* decodeWork(
          {
            id: row.id,
            space: row.space,
            memoryId: row.memory_id,
            kind: row.kind,
            status: row.status,
            metadata:
              decodedMetadata.kind === "claim"
                ? { ...decodedMetadata, generation: row.sync_version ?? 0 }
                : decodedMetadata,
            payloadRef: row.payload_ref,
            attempt: row.attempt,
            nextAttemptAt: row.next_attempt_at,
            claimedBy: row.claimed_by,
            claimedUntil: row.claimed_until,
          },
          strict,
        );
      }),
    ),
  );
});
export type WorkRow = Parameters<typeof workRows>[0][number];
export const holdRearmResult = (
  rows: readonly { id: string }[],
  changedIds: readonly string[],
  limit: number,
): HoldRearmPage => ({
  changedIds,
  inspected: rows.length,
  next: rows.at(-1)?.id ?? null,
  more: rows.length > 0 && rows.length === Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS)),
});
export const claimCodec = codec(M.MemoryHubClaimInput);
export const storedTicketRowCodec = codec(StoredTicketRowSchema);
export const adminCodec = codec(AdminRecordSchema);
export const adminActionCodec = codec(PersistedAdminActionSchema);
export const adminReplayCodec = codec(AdminReplaySchema);
export const adminReplayJson = Effect.fnUntraced(function* (record: AdminRecord) {
  const { action, ...replay } = record;
  return yield* adminReplayCodec.encode({
    ...replay,
    stage: "acknowledged" as const,
    actionDigest: hashText(yield* adminActionCodec.encode(action)),
  });
});
export const hubEntryCodec = codec(M.MemoryHubEntry);
export const stringArrayCodec = codec(Schema.Array(Schema.String));
export const handleCodec = codec(Schema.Array(HubCheckpointHandleSchema));
export const snapshotId = (id: string) => `hub:${id}`;
