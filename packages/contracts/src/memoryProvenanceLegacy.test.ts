import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as M from "./index.ts";

const id = () => "00000000-0000-4000-8000-000000000001";

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
