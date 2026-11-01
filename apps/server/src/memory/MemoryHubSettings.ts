import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MemoryHubProvenance = Schema.Struct({
  source: Schema.Literal("auto-initialized"),
  memorySpaceId: M.MemorySpaceId,
});
export type MemoryHubProvenance = typeof MemoryHubProvenance.Type;

/** Server-only receipts retain initialization origin without changing existing RPC payloads. */
export const MemoryHubSettingsSnapshot = Schema.Struct({
  settings: M.MemoryHubSettings,
  version: M.NonNegativeInt,
  provenance: Schema.NullOr(MemoryHubProvenance).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
}).check(
  Schema.makeFilter(
    (view) =>
      view.provenance === null ||
      (view.settings.mode === "hub" &&
        view.settings.memorySpaceId === view.provenance.memorySpaceId),
  ),
);
export type MemoryHubSettingsSnapshot = typeof MemoryHubSettingsSnapshot.Type;
