import type { EnvironmentId } from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import type { LaunchWatch } from "./launchWatch.ts";

export class LaunchWatchStoreError extends Data.TaggedError("LaunchWatchStoreError")<{
  readonly message: string;
  readonly code?: "watch_origin_conflict";
  readonly cause?: unknown;
}> {}

export const originFor = (
  existing: LaunchWatch | undefined,
  incoming: EnvironmentId | null | undefined,
) => {
  const stored = existing?.sourceEnvironmentId ?? null;
  if (stored !== null && incoming != null && incoming !== stored)
    return Effect.fail(
      new LaunchWatchStoreError({
        code: "watch_origin_conflict",
        message: `Watch origin ${stored} conflicts with ${incoming}.`,
      }),
    );
  return Effect.succeed(incoming ?? stored);
};

export const makeReplicationChoice = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  Effect.fn("LaunchWatchService.withReplicationChoice")(function* (watch: LaunchWatch) {
    if (watch.launcherThreadId === null) return { ...watch, checkpointReplication: "off" as const };
    const config = yield* settings.getSettings.pipe(Effect.option);
    const choice =
      Option.isSome(config) && watch.host !== null
        ? config.value.fleet.hosts?.[watch.host]?.checkpointReplication
        : "off";
    return {
      ...watch,
      checkpointReplication:
        choice === "off"
          ? ("off" as const)
          : (watch.checkpointReplication ?? choice ?? ("off" as const)),
    };
  });
