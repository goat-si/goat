import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live("keeps a worktree when Git reports an invalid gitfile", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { service, fs, worktree, setGitfileDiagnostic } = yield* cleanupFixture();
      yield* fs.remove(`${worktree}/.git`);
      yield* fs.writeFileString(`${worktree}/.git`, "gitdir: /missing-git-directory\n");
      setGitfileDiagnostic("fatal: gitfile does not point to a valid repository: /missing\n");
      expect((yield* service.runNow).entries[0]).toMatchObject({
        outcome: "kept",
        reason: "Repository or branch changed",
      });
    }),
  ),
);
