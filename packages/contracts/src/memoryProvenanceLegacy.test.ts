import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as M from "./index.ts";

const id = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("preserves the stored failure-code ordinals from memory protocol V1", () => {
  expect(M.MemoryFailureCode.literals).toEqual([
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
    "move_receipt_missing",
  ]);
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

const strict = Schema.decodeUnknownSync(M.MemoryOperation, { onExcessProperty: "error" });
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
  expect(() => strict({ ...value, closedLineage: true })).toThrow();
  expect(() => strict({ ...value, payload: { text: "Synthetic" } })).toThrow();
  expect(() => strict({ ...value, toScope: value.fromScope })).toThrow();
  expect(() => strict({ ...value, expectedScopeVersion: -1 })).toThrow();
});
