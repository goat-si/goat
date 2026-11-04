import * as Effect from "effect/Effect";

// Runtimes started before GOAT_RUNTIME_ORIGIN existed still carry their SSH launch markers.
export const isSshProvisionedRuntime: Effect.Effect<boolean> = Effect.sync(
  () =>
    process.env.GOAT_RUNTIME_ORIGIN === "ssh" ||
    (process.env.GOAT_SSH_REPLACEMENT_ID ?? "") !== "" ||
    (process.env.SSH_CONNECTION ?? "") !== "",
);
