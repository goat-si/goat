import * as Effect from "effect/Effect";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";

export const savedWorktreeFallback = Effect.fn("ThreadLaunchService.savedWorktreeFallback")(
  function* (
    git: GitWorkflowService["Service"],
    cwd: string,
    requestedBaseRef: string,
    startFromOrigin: boolean,
    preferredRemote: string | undefined,
    note: (line: string) => Effect.Effect<void>,
  ) {
    if (
      requestedBaseRef.startsWith(":") ||
      (yield* git.hasCommit({
        cwd,
        refName: requestedBaseRef === "-" ? "@{-1}" : requestedBaseRef,
      })) ||
      (yield* git.hasRefNamed({ cwd, refName: requestedBaseRef }))
    )
      return null;
    if (startFromOrigin) {
      const fetched = yield* git.resolveWorktreeFallbackRemote(cwd, preferredRemote).pipe(
        Effect.flatMap((remote) =>
          remote === null
            ? Effect.succeed(null)
            : git.fetchWorktreeBaseCommit({
                cwd,
                refName: remote.branchName,
                remote,
                onOutputLine: note,
              }),
        ),
        Effect.catch((error) =>
          note(`Could not fetch the default branch: ${error.detail}`).pipe(Effect.as(null)),
        ),
      );
      if (fetched !== null)
        return {
          startRef: fetched.commitSha,
          baseRefName: `refs/remotes/${fetched.remoteRefName}`,
        };
    }
    return (yield* git.hasCommit({ cwd, refName: "HEAD" }))
      ? { startRef: "HEAD", baseRefName: (yield* git.currentBranch(cwd)) ?? "HEAD" }
      : null;
  },
);
