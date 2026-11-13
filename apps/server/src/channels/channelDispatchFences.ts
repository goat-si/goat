import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import type { ChannelLedgerError } from "./channelLedgerError.ts";

/** Sees each automatic placement's fiber as it starts; tests await the placement through it. */
export const PlacementStarted = Context.Reference<
  (fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
>("goat/channels/ChannelDispatcher/PlacementStarted", { defaultValue: () => () => Effect.void });

/**
 * Drops a version-fenced task write that another writer beat since the read it was decided from:
 * the task moved on, and the next pass decides again from a fresh read. Any other error stays.
 */
export const unlessMovedOn = <A, R>(write: Effect.Effect<A, ChannelLedgerError, R>) =>
  write.pipe(
    Effect.catchIf(
      (error) => error.reason === "version_conflict",
      () => Effect.void,
    ),
  );
