import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { GitCommandError } from "@goat/contracts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { runCleanupTest, submoduleCleanupFixture } from "./storageCleanup.testkit.ts";

it.live(
  "keeps untracked submodule files even when the root policy keeps only tracked changes",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* submoduleCleanupFixture();
        fixture.setPolicy("tracked-changes");
        yield* fixture.fs.writeFileString(`${fixture.child}/notes.txt`, "local untracked work\n");
        const report = yield* fixture.service.runNow;
        expect(report.entries.find((entry) => entry.path === fixture.worktree)).toMatchObject({
          outcome: "kept",
        });
        expect(yield* fixture.fs.readFileString(`${fixture.child}/notes.txt`)).toBe(
          "local untracked work\n",
        );
      }),
    ),
);

it.live("keeps untracked files in a deinitialized submodule under tracked-only cleanup", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* submoduleCleanupFixture();
      fixture.setPolicy("tracked-changes");
      yield* fixture.command(fixture.submodule, ["submodule", "deinit", "child"]);
      yield* fixture.fs.writeFileString(`${fixture.child}/notes.txt`, "detached local work\n");
      const report = yield* fixture.service.runNow;
      expect(report.entries.find((entry) => entry.path === fixture.worktree)).toMatchObject({
        outcome: "kept",
      });
      expect(yield* fixture.fs.readFileString(`${fixture.child}/notes.txt`)).toBe(
        "detached local work\n",
      );
    }),
  ),
);

it.live("keeps the worktree when a submodule common directory cannot be inspected", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const fixture = yield* submoduleCleanupFixture().pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, {
          ...git,
          execute: (input) =>
            input.operation === "StorageCleanup.submodules" &&
            input.args.includes("--git-common-dir")
              ? Effect.fail(
                  new GitCommandError({
                    operation: input.operation,
                    command: "git",
                    cwd: input.cwd,
                    detail: "unavailable",
                  }),
                )
              : git.execute(input),
        }),
      );
      const report = yield* fixture.service.runNow;
      expect(report.entries.find((entry) => entry.path === fixture.worktree)).toMatchObject({
        outcome: "kept",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }),
  ),
);
