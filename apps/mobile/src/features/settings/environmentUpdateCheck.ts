import * as Effect from "effect/Effect";

import { findEnvironmentUpdate } from "./environment-maintenance";

export const checkEnvironmentUpdate = Effect.fn("mobile.checkEnvironmentUpdate")(
  (fromVersion: string) =>
    Effect.tryPromise({
      try: (signal) => findEnvironmentUpdate(fromVersion, signal),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error("Could not check for updates."),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () => Effect.fail(new Error("Checking for updates timed out. Try again.")),
      }),
    ),
);
