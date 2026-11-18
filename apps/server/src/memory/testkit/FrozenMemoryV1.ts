import * as M from "@goat/contracts";
import * as Schema from "effect/Schema";

// Failure fields frozen at 1f29ca39ff5f4947d3d8948396e0d2f38a6f1ca6.
const MemoryFailureCode = Schema.Literals([
  "unavailable",
  "source_unavailable",
  "not_found",
  "forgotten",
  "revision_changed",
  "operation_id_reused",
  "missing_parent",
  "conflict_changed",
  "lease_expired",
  "fenced",
  "claim_busy",
  "invalid_output",
  "generation_failed",
  "secret_detected",
  "bootstrap_required",
  "space_mismatch",
  "unsupported_protocol",
  "invalid_cursor",
  "cursor_expired",
  "hub_disabled",
  "identity_mismatch",
  "route_unavailable",
  "lease_required",
  "attempt_expired",
  "unsupported_operation",
  "payload_too_large",
  "generation_input_too_large",
  "storage_failed",
  "source_invalidated",
  "thread_lineage_incomplete",
  "capacity_exceeded",
  "base_compacted",
  "revert_expired",
  "scanner_pending",
  "forget_pending",
]);
const MemoryCapacityDimension = Schema.Literals([
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
  "import_lineage_records",
  "import_lineage_bytes",
]);

const capacity = Schema.optionalKey(
  Schema.Struct({
    code: Schema.Literal("capacity_exceeded"),
    current: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
    reclaimable: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    dimension: MemoryCapacityDimension,
  }),
);
const failureCode = Schema.optionalKey(MemoryFailureCode);
const options = { onExcessProperty: "error" } as const;

export const decodeLegacyError = Schema.decodeUnknownSync(
  Schema.Struct({
    _tag: Schema.Literal("MemoryRpcError"),
    code: MemoryFailureCode,
    memoryId: Schema.optionalKey(M.MemoryId),
    operationId: Schema.optionalKey(M.MemoryOperationId),
    capacity,
    guidance: Schema.optionalKey(
      Schema.Literal(
        "This conversation has incomplete memory provenance and cannot save new memories. Start a new conversation to save this memory.",
      ),
    ),
  }),
  options,
);

export const decodeLegacyMutationReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    operationId: M.MemoryOperationId,
    memoryId: M.MemoryId,
    outcome: Schema.Literals(["accepted", "noop", "conflicted", "deleted", "rejected"]),
    revisionId: Schema.NullOr(M.MemoryRevisionId),
    pendingSync: Schema.Boolean,
    failureCode,
    capacity,
  }),
  options,
);

export const decodeLegacyUpsert = Schema.decodeUnknownSync(
  Schema.Struct({
    memorySpaceId: M.MemorySpaceId,
    operationId: M.MemoryOperationId,
    memoryId: M.MemoryId,
    expectedHeads: Schema.Array(M.MemoryRevisionId),
    scope: M.MemoryScope,
    assertionKind: M.MemoryAssertionKind,
    baseBoundary: Schema.NullOr(M.MemoryCausalBoundary),
    payload: M.MemoryPayload.check(
      Schema.makeFilter((v) => v.derivedFromMemoryRevisions.length <= 100),
    ),
  }),
  options,
);

export const decodeLegacyPushResult = Schema.decodeUnknownSync(
  Schema.Struct({
    receipts: Schema.Array(
      Schema.Struct({
        operationId: M.MemoryOperationId,
        memoryId: M.MemoryId,
        operationDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
        outcome: Schema.Literals(["accepted", "conflicted", "deleted", "rejected"]),
        hubSequence: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
        failureCode,
        capacity,
      }),
    ),
  }),
  options,
);
