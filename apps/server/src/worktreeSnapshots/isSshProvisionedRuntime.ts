import * as Effect from "effect/Effect";

export const isSshProvisionedRuntime: Effect.Effect<boolean> = Effect.sync(
  () => process.env.GOAT_RUNTIME_ORIGIN === "ssh",
);
