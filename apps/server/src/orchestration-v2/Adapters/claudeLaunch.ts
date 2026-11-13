import type { ClaudeSettings, ProviderInstanceEnvironment } from "@goat/contracts";
import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveClaudeSdkExecutablePath } from "../../provider/Drivers/ClaudeExecutable.ts";
import {
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
} from "../../provider/Drivers/ClaudeHome.ts";

export interface ClaudeLaunch {
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
}

/** Resolved again for each new query and fork, since the host PATH can change after the adapter starts. */
export const makeClaudeLaunchResolver = Effect.fn("ClaudeAdapterV2.makeLaunchResolver")(function* (
  config: ClaudeSettings,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const home = yield* HostProcess.HomeDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.gen(function* () {
    const base = yield* mergeClaudeProcessEnvironment(config, instanceEnvironment, hostEnvironment);
    const environment = yield* makeClaudeEnvironment(config, base);
    const binaryPath = yield* resolveClaudeSdkExecutablePath(
      expandHomePath(config.binaryPath, home),
      environment,
    );
    return { environment, binaryPath } satisfies ClaudeLaunch;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
});
