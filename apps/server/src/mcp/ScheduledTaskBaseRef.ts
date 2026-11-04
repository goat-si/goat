import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const resolveScheduledTaskBaseRef = Effect.fn("ScheduledTask.resolveBaseRef")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
) {
  const exists = (revision: string) =>
    git.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.orElseSucceed(() => null));
  const conventional = ["main", "master"];
  if (remote !== null) {
    const remoteDefault = yield* git
      .resolveDefaultBranchName(cwd, remote)
      .pipe(Effect.orElseSucceed(() => null));
    for (const branch of remoteDefault === null ? conventional : [remoteDefault, ...conventional]) {
      if (yield* exists(`refs/remotes/${remote}/${branch}`)) return `${remote}/${branch}`;
    }
  }
  for (const branch of conventional) {
    if (yield* exists(`refs/heads/${branch}`)) return branch;
  }
  return "main";
});
