import * as Effect from "effect/Effect";

import * as MemoryService from "./memory/MemoryService.ts";

/** SQL-free live scope reads can safely run again after a source wait or inside a transaction. */
export const memorySessionPermit = <E>(
  liveScopes: Effect.Effect<ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>, E>,
  capturedScopes: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>,
  required: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>,
) =>
  liveScopes.pipe(
    Effect.flatMap((live) =>
      required.every((scope) => capturedScopes.includes(scope) && live.includes(scope))
        ? Effect.void
        : Effect.fail(new MemoryService.MemoryAccessError({ code: "unavailable" })),
    ),
    Effect.mapError(() => new MemoryService.MemoryAccessError({ code: "unavailable" })),
  );
