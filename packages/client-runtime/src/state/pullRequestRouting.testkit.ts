import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const trustedRouting = {
  get: () => Effect.succeed("read-write" as const),
  changes: Stream.empty,
  set: () => Effect.void,
  forget: () => Effect.void,
};
