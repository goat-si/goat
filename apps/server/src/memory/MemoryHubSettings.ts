import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { MemoryStore } from "./MemoryStore.ts";

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

/** Live roster is never persisted in settings receipts or returned by the disable tool. */
export const readSettingsView = Effect.fn("MemoryHubSettings.readView")(function* (
  store: MemoryStore["Service"],
  snapshot: M.MemoryHubSettingsSnapshot,
) {
  const members =
    snapshot.settings.mode === "hub" && snapshot.settings.memorySpaceId !== null
      ? yield* store.readHubMembers(snapshot.settings.memorySpaceId)
      : [];
  return { settings: snapshot.settings, version: snapshot.version, members };
});
