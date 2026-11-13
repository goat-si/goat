import type { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const localTrackingDestination = Effect.fn("GitVcsDriver.localTrackingDestination")(
  function* (
    cwd: string,
    branch: string,
    readConfig: (cwd: string, key: string) => Effect.Effect<string | null, GitCommandError>,
    readUpstream: (cwd: string) => Effect.Effect<string | null, GitCommandError>,
    resolveRemote: (cwd: string, branch: string) => Effect.Effect<string | null, GitCommandError>,
  ) {
    if ((yield* readConfig(cwd, `branch.${branch}.remote`)) !== ".")
      return { local: false as const };
    const upstream = yield* readUpstream(cwd).pipe(Effect.orElseSucceed(() => null));
    const remote = yield* resolveRemote(cwd, branch).pipe(Effect.orElseSucceed(() => null));
    return {
      local: true as const,
      destination:
        upstream !== null && remote !== null
          ? {
              remoteName: remote,
              branchName: branch,
              publishes: true,
              upstream: { remoteName: ".", branchName: upstream, upstreamRef: upstream },
            }
          : null,
    };
  },
);
