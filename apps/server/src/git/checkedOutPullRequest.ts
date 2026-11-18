import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const key = (branch: string) => `branch.${branch}.goat-pull-request`;

export const makeCheckedOutPullRequest = (git: GitVcsDriver.GitVcsDriver["Service"]) => ({
  read: Effect.fn("GitManager.checkedOutPullRequest")(function* (input: {
    cwd: string;
    branch: string;
    url: string;
  }) {
    const value = yield* git
      .readConfigValue(input.cwd, key(input.branch))
      .pipe(Effect.orElseSucceed(() => null));
    return value === input.url;
  }),
  write: (cwd: string, branch: string, url: string) =>
    git
      .writeConfigValue({ cwd, key: key(branch), value: url })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not mark the checked-out pull request", { branch, cause }),
        ),
      ),
});
