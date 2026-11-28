import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const recoverBranchRename = (
  error: GitCommandError,
  oldBranch: Effect.Effect<boolean, GitCommandError>,
  newBranch: Effect.Effect<boolean, GitCommandError>,
) =>
  Effect.all([oldBranch, newBranch], { concurrency: "unbounded" }).pipe(
    Effect.orElseSucceed(() => [true, false] as const),
    Effect.flatMap(([oldExists, newExists]) =>
      !oldExists && newExists
        ? Effect.logWarning(
            "GitVcsDriver.renameBranch: renamed the branch but could not move its config entries",
          )
        : Effect.fail(error),
    ),
  );
