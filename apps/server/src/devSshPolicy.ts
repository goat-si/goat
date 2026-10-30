import type * as ServerConfig from "./config.ts";
import { DEV_SSH_REFUSAL, refuseSshHosts } from "@goat/ssh/hostAccess";
import * as Effect from "effect/Effect";

/**
 * A dev server runs on a copy of the developer's data and their home directory, so it would reach
 * their real machines from copied hub nodes, OpenCodex links and SSH config. It refuses SSH for
 * the whole process unless GOAT_DEV_SSH=on. Every dev-runner mode and the desktop dev backend
 * (including WSL) pass a dev URL, so losing the variable on the way refuses rather than allows.
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
  yield* Effect.logInfo(
    "This dev server does not SSH into other machines. Set GOAT_DEV_SSH=on to test remote features.",
  );
});
