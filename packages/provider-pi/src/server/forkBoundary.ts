import type { OrchestrationV2ProviderTurn, ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { piSessionListing, walkPiBranch, type PiSessionListing } from "./entries.ts";

export type PiForkBoundary =
  | { readonly type: "entry"; readonly entryId: string }
  | { readonly type: "nothing" }
  | {
      readonly type: "uncaptured";
      readonly turn: OrchestrationV2ProviderTurn;
      readonly target: OrchestrationV2ProviderTurn | null;
    };

/**
 * Turns without a ref left nothing on the active branch, so the boundary is the first discarded
 * turn that has one. `uncaptured` is a boundary turn still carrying its synthetic ref (only
 * `captureTurnTreeRefs` records strong ones); `piForkEntry` locates it in the session tree.
 */
export function piForkBoundary(input: {
  readonly target:
    | { readonly type: "thread_start" }
    | { readonly type: "provider_turn"; readonly providerTurn: OrchestrationV2ProviderTurn };
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): PiForkBoundary {
  const target = input.target.type === "thread_start" ? null : input.target.providerTurn;
  const boundary = input.providerThreadTurns
    .filter((turn) => turn.ordinal > (target?.ordinal ?? 0) && turn.nativeTurnRef !== null)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  const ref = boundary?.nativeTurnRef;
  if (boundary === undefined || ref == null) return { type: "nothing" };
  return ref.strength === "strong" && ref.nativeId !== null
    ? { type: "entry", entryId: ref.nativeId }
    : { type: "uncaptured", turn: boundary, target };
}

/** Reads the session tree only for an uncaptured boundary. */
export function piForkEntry<E>(
  driver: ProviderDriverKind,
  boundary: Exclude<PiForkBoundary, { type: "nothing" }>,
  providerThreadCreatedAt: DateTime.Utc,
  readEntries: Effect.Effect<unknown, E>,
): Effect.Effect<string, E | ProviderAdapter.ProviderAdapterProtocolError> {
  if (boundary.type === "entry") return Effect.succeed(boundary.entryId);
  return readEntries.pipe(
    Effect.flatMap((data) => {
      const listing = piSessionListing(data);
      const entryId =
        listing === null
          ? undefined
          : piUncapturedForkEntry(listing, boundary, providerThreadCreatedAt);
      return entryId === undefined
        ? Effect.fail(
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: `Pi turn ${boundary.turn.ordinal} has no captured session-tree entry and none was found in the session tree`,
            }),
          )
        : Effect.succeed(entryId);
    }),
  );
}

/**
 * Pi shares the server clock. An adopted wake can precede its GOAT turn, so search from the target
 * turn's end through the boundary turn's end. A boundary turn still running has no end yet, so
 * the window stays open through the tree read. At thread start, use the earlier of thread
 * creation and turn start to include adopted wakes while preserving inherited session history.
 */
function piUncapturedForkEntry(
  listing: PiSessionListing,
  boundary: Extract<PiForkBoundary, { type: "uncaptured" }>,
  providerThreadCreatedAt: DateTime.Utc,
): string | undefined {
  const { startedAt, completedAt } = boundary.turn;
  if (startedAt === null) return undefined;
  const from =
    boundary.target === null
      ? Math.min(DateTime.toEpochMillis(providerThreadCreatedAt), DateTime.toEpochMillis(startedAt))
      : DateTime.toEpochMillis(boundary.target.completedAt ?? startedAt);
  const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
  const targetRef = boundary.target?.nativeTurnRef;
  const stopAt = targetRef?.strength === "strong" ? targetRef.nativeId : null;
  if (stopAt !== null && !listing.entries.has(stopAt)) return undefined;
  const walk = walkPiBranch(listing.entries, listing.leafId, stopAt);
  if (walk === null || !walk.reachedStop) return undefined;
  let earliest: string | undefined;
  for (const id of walk.userEntryIds) {
    const timestamp = listing.entries.get(id)?.timestamp;
    if (timestamp == null) return undefined;
    if (timestamp >= from && timestamp <= to) earliest = id;
  }
  return earliest;
}
