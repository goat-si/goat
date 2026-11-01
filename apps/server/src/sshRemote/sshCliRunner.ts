import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type * as SshTunnel from "@goat/ssh/tunnel";

import packageJson from "../../package.json" with { type: "json" };
import { BUILD_COMMIT_TIME } from "../buildCommitTime.ts";

/**
 * Resolve local archive/mirror configuration before building the remote runner.
 * The server owns the host's runtime like the desktop does: it installs its own
 * release on a stopped host and refreshes an older compatible server once it
 * answers idle. Replacement only happens through the server's own drain, so
 * another client attached to it is never cut off mid-turn.
 */
export const resolveSshCliRunner = Effect.fn("SshRemoteDispatch.resolveSshCliRunner")(function* (
  baseDir: string,
) {
  const archiveDirectory = yield* Config.String("GOAT_SSH_RUNTIME_ARCHIVE_DIR").pipe(
    Config.withDefault(baseDir + "/runtime/archives"),
  );
  const bundledArchiveDirectory = yield* Config.String("GOAT_SSH_BUNDLED_RUNTIME_ARCHIVE_DIR").pipe(
    Config.withDefault(""),
    Effect.map((value) => value.trim() || undefined),
  );
  const releaseBaseUrl = yield* Config.String("GOAT_RELEASE_BASE_URL").pipe(
    Config.withDefault(""),
    Effect.map((value) => value.trim() || undefined),
  );
  const nodeScriptPath = yield* Config.String("GOAT_DEV_REMOTE_SERVER_ENTRY_PATH").pipe(
    Config.withDefault(""),
  );
  return {
    ...(nodeScriptPath.trim()
      ? { nodeScriptPath: nodeScriptPath.trim(), nodeEngineRange: packageJson.engines.node }
      : {}),
    archiveVersion: packageJson.version,
    ...(BUILD_COMMIT_TIME === undefined ? {} : { archiveCommitTime: BUILD_COMMIT_TIME }),
    archiveDirectory,
    ...(bundledArchiveDirectory === undefined ? {} : { bundledArchiveDirectory }),
    ...(releaseBaseUrl === undefined ? {} : { releaseBaseUrl }),
    hostDownload: true,
    publishedFallback: true,
    attachAppServer: true,
    refreshOwnedRuntimeOnFirstConnection: true,
  } satisfies SshTunnel.RemoteGoatRunnerOptions;
});
