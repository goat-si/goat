import { LOGIN_SHELL_RETRY_DELAYS_MS } from "@goat/shared/cliPath";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * Runs one discovery, then a fixed number of further ones with growing gaps until one succeeds.
 * Sequential, so no two login shells are probed at once. Windows keeps its single probe.
 */
export const discoverWithRetries = Effect.fn("desktop.shellEnvironment.discoverWithRetries")(
  function* (discover: Effect.Effect<boolean>, platform: NodeJS.Platform) {
    if (yield* discover) return true;
    if (platform !== "darwin" && platform !== "linux") return false;
    for (const delay of LOGIN_SHELL_RETRY_DELAYS_MS) {
      yield* Effect.sleep(Duration.millis(delay));
      if (yield* discover) return true;
    }
    yield* Effect.logWarning("The login shell never answered with a PATH; no further probes.").pipe(
      Effect.annotateLogs({ component: "desktop-shell-environment" }),
    );
    return false;
  },
);
