import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { runCleanupTest, submoduleCleanupFixture } from "./storageCleanup.testkit.ts";

it.live("forced submodule removal does not erase untracked files before a late tracked edit", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const fixture = yield* submoduleCleanupFixture().pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, {
          ...git,
          execute: (input) =>
            git
              .execute(input)
              .pipe(
                Effect.tap(() =>
                  input.args[0] === "clean"
                    ? fs.writeFileString(`${input.cwd}/tracked.txt`, "late edit\n")
                    : Effect.void,
                ),
              ),
        }),
      );
      fixture.setPolicy("tracked-changes");
      yield* fs.writeFileString(`${fixture.worktree}/notes.txt`, "untracked data\n");
      const report = yield* fixture.service.runNow;
      const outcome = report.entries.find((entry) => entry.path === fixture.worktree)?.outcome;
      if (outcome === "kept") {
        expect(yield* fs.readFileString(`${fixture.worktree}/notes.txt`)).toBe("untracked data\n");
      } else {
        expect(outcome).toBe("removed");
      }
    }),
  ),
);
