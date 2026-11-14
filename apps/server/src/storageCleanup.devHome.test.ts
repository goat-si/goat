import { it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";
import * as ServerConfig from "./config.ts";
import { shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live.each([
  { home: "an installed", worktreeHome: false, customFolderOutcome: "removed" },
  { home: "a git worktree's dev", worktreeHome: true, customFolderOutcome: "kept" },
] as const)(
  "on $home home, a custom worktrees folder ends $customFolderOutcome",
  ({ worktreeHome, customFolderOutcome }) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-dev-checkout-" });
        yield* fs.writeFileString(`${checkout}/.git`, "gitdir: /repo/.git/worktrees/dev\n");
        const baseDir = worktreeHome ? `${checkout}/.goat` : config.baseDir;
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            baseDir,
            worktreesDir: `${baseDir}/worktrees`,
          }),
        );
        const customFolder = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-real-worktrees-" }),
        );
        const realWorktree = `${customFolder}/seeded`;
        yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "seeded", realWorktree]);
        fixture.setSettings({ worktreesDirectory: customFolder });
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree }),
          shell({
            id: ThreadId.make("seeded"),
            lineage: {
              rootThreadId: ThreadId.make("seeded"),
              parentThreadId: null,
              relationshipToParent: null,
            },
            branch: "seeded",
            worktreePath: realWorktree,
          }),
        ]);

        const { entries } = yield* fixture.service.runNow;

        expect(entries.find((entry) => entry.path === realWorktree)?.outcome).toBe(
          customFolderOutcome,
        );
        expect(yield* fs.exists(realWorktree)).toBe(customFolderOutcome === "kept");
        expect(yield* fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
);
