import type * as ServerConfig from "./config.ts";
import { DEV_SSH_REFUSAL, refuseSshHosts } from "@goat/ssh/hostAccess";
import * as Effect from "effect/Effect";

// Git runs this through sh with the host and command appended, which `false` ignores.
const GIT_SSH_REFUSAL = `echo '${DEV_SSH_REFUSAL}' >&2; false`;

/**
 * A dev server reads copied hub nodes and the developer's real SSH and OpenCodex config, so it
 * refuses SSH process-wide unless GOAT_DEV_SSH=on. Every dev mode passes a dev URL, so a lost
 * variable refuses. Git starts ssh itself, so its children inherit a refusing GIT_SSH_COMMAND.
 */
export const applyDevSshPolicy = Effect.fn("applyDevSshPolicy")(function* (
  config: Pick<ServerConfig.ServerConfig["Service"], "devUrl">,
  environment: NodeJS.ProcessEnv,
) {
  if (config.devUrl === undefined) return;
  if (environment.GOAT_DEV_SSH === "on") {
    yield* Effect.logWarning(
      "GOAT_DEV_SSH=on: this dev server may SSH into other machines, including hosts from your SSH and OpenCodex config.",
    );
    return;
  }
  yield* refuseSshHosts(DEV_SSH_REFUSAL);
  environment.GIT_SSH_COMMAND = GIT_SSH_REFUSAL;
  yield* Effect.logInfo(
    "This dev server does not SSH into other machines. Set GOAT_DEV_SSH=on to test remote features.",
  );
});
