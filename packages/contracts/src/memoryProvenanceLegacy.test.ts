import * as Schema from "effect/Schema";
import * as M from "./index.ts";
import { expect, it } from "vite-plus/test";
import { MemoryFailureCode } from "./memory.ts";

it("preserves the stored failure-code ordinals from memory protocol V1", () => {
  expect(MemoryFailureCode.literals).toEqual([
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
    "hub_upgrade_required",
    "hub_unavailable",
  ]);
});

const strict = Schema.decodeUnknownSync(M.MemoryOperation, { onExcessProperty: "error" });
const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const thread = { environmentId: "env", threadId: "thread" };

it("encodes moves without a body and only at the negotiated floor", () => {
  const value = {
    protocolVersion: 1,
    kind: "move",
    operationId: id(4),
    memorySpaceId: id(),
    originEnvironmentId: thread.environmentId,
    memoryId: id(2),
    expectedHeads: [id(3)],
    expectedScopeVersion: 7,
    fromScope: { kind: "user" },
    toScope: { kind: "thread", thread },
  };
  const move = strict(value);
  expect(M.decodeMemoryOperation(M.encodeMemoryOperation(move))).toEqual(move);
  expect(JSON.parse(M.encodeMemoryOperation(move))).toEqual(value);
  expect(JSON.parse(M.encodeMemoryEventMetadata(move))).toEqual(value);
  expect(M.requiresMemoryFloor2(move)).toBe(true);
  expect(() => strict({ ...value, payload: { text: "Synthetic" } })).toThrow();
  expect(() => strict({ ...value, toScope: value.fromScope })).toThrow();
  expect(() => strict({ ...value, expectedScopeVersion: -1 })).toThrow();
});
