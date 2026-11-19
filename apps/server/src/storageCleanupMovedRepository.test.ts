import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live(
  "removes a managed worktree through the repository that owns it after a project moves",
  () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        const { fs, command, config } = fixture;
        const oldRepo = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-old-repo-" }),
        );
        yield* command(oldRepo, ["init", "-b", "main"]);
        yield* command(oldRepo, ["config", "user.email", "cleanup@example.test"]);
        yield* command(oldRepo, ["config", "user.name", "Cleanup test"]);
        yield* fs.writeFileString(`${oldRepo}/tracked.txt`, "original\n");
        yield* command(oldRepo, ["add", "."]);
        yield* command(oldRepo, ["commit", "-m", "initial"]);
        yield* fs.makeDirectory(`${config.worktreesDir}/old-repo`, { recursive: true });
        const oldWorktree = `${config.worktreesDir}/old-repo/feature`;
        yield* command(oldRepo, ["worktree", "add", "-b", "feature", oldWorktree]);
        fixture.setThreads([shell({ branch: "feature", worktreePath: oldWorktree })]);
        const report = yield* fixture.service.runNow;
        expect(report.entries.find((entry) => entry.path === oldWorktree)).toMatchObject({
          outcome: "removed",
        });
        expect(yield* fs.exists(oldWorktree)).toBe(false);
        expect((yield* command(oldRepo, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
          oldWorktree,
        );
      }),
    ),
);
