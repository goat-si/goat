import type { GitPreparePullRequestThreadInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

export const makePullRequestSetup = Effect.gen(function* () {
  const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  return Effect.fn("GitManager.runPullRequestSetup")(function* (
    input: GitPreparePullRequestThreadInput,
    worktreePath: string,
  ) {
    if (!input.threadId) return;
    yield* runner
      .runForThread({ threadId: input.threadId, projectCwd: input.cwd, worktreePath })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("GitManager.preparePullRequestThread setup script failed", {
            threadId: input.threadId,
            worktreePath,
            cause,
          }),
        ),
      );
  });
});
