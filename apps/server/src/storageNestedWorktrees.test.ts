import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

describe("nested worktree reports", () => {
  it.live("reports linked worktrees nested deeper inside a plain folder", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const replay = `${fixture.config.worktreesDir}/repository/replay`;
        const deep = `${fixture.config.worktreesDir}/repository/deep`;
        const worktrees = [`${deep}/a/b`, `${replay}/1376`];
        for (const [index, worktree] of worktrees.entries()) {
          yield* fixture.command(fixture.repo, [
            "worktree",
            "add",
            "-b",
            `nested-${index}`,
            worktree,
          ]);
        }
        for (const folder of [...worktrees, `${deep}/a`, deep, replay]) {
          yield* fixture.fs.utimes(folder, 1, 1);
        }
        const report = yield* fixture.service.runNow;
        expect(
          report.entries
            .map((entry) => ({ path: entry.path, reason: entry.reason }))
            .sort((left, right) => String(left.path).localeCompare(String(right.path))),
        ).toEqual(worktrees.map((path) => ({ path, reason: "No thread uses this worktree" })));
      }),
    ),
  );

  it.live("still reports a plain folder whose nested worktree registration is stale", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const replay = `${fixture.config.worktreesDir}/repository/replay`;
        const worktree = `${replay}/1376`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "locked", worktree]);
        yield* fixture.command(fixture.repo, ["worktree", "lock", worktree]);
        yield* fixture.fs.rename(worktree, `${replay}/moved`);
        yield* fixture.fs.makeDirectory(worktree);
        yield* fixture.fs.utimes(replay, 1, 1);
        expect((yield* fixture.service.runNow).entries.map((entry) => entry.path)).toEqual([
          replay,
        ]);
      }),
    ),
  );

  it.live("does not report nested worktrees inside a project checkout", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setThreads([]);
        const project = `${fixture.config.worktreesDir}/repository/replay/project`;
        const worktree = `${project}/nested`;
        yield* fixture.fs.makeDirectory(project, { recursive: true });
        fixture.setProjectRoots([fixture.repo, project]);
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "nested", worktree]);
        for (const folder of [worktree, project]) yield* fixture.fs.utimes(folder, 1, 1);
        expect((yield* fixture.service.runNow).entries).toEqual([]);
      }),
    ),
  );
});
