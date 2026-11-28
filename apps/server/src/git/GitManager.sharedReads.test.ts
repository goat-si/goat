import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { initRepo, runGit } from "./testkit/gitRepository.ts";
import { layerGitManagerTest, makeManager } from "./GitManagerTestHarness.ts";

const BRANCHES = ["feature/a", "feature/b", "feature/c"] as const;

// Sharing stops when a user git config has includes; keep the developer's own out of the test.
const isolateUserGitConfig = Effect.acquireRelease(
  Effect.sync(() => {
    const previous = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    return previous;
  }),
  (previous) =>
    Effect.sync(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }),
);

it.layer(layerGitManagerTest)("GitManager lookups across linked worktrees", (it) => {
  it.effect(
    "linked worktrees share remote reads until the remote changes, a refresh, or invalidation",
    () =>
      Effect.gen(function* () {
        yield* isolateUserGitConfig;
        const repo = yield* makeTempDir("goat-shared-reads-");
        yield* initRepo(repo);
        yield* runGit(repo, ["remote", "add", "origin", "https://github.com/example/project.git"]);
        const worktrees: string[] = [];
        for (const branch of BRANCHES) {
          const worktree = `${yield* makeTempDir("goat-shared-reads-wt-")}/checkout`;
          yield* runGit(repo, ["worktree", "add", "-b", branch, worktree]);
          yield* runGit(repo, ["config", `branch.${branch}.remote`, "origin"]);
          yield* runGit(repo, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
          yield* runGit(repo, ["update-ref", `refs/remotes/origin/${branch}`, branch]);
          worktrees.push(worktree);
        }
        const commands: string[] = [];
        const { manager } = yield* makeManager({ gitCommands: commands });
        const lookup = (index: number, options?: { readonly refresh?: boolean }) =>
          manager.branchPullRequest({ cwd: worktrees[index]!, branch: BRANCHES[index]! }, options);
        // Reads every worktree of the repository answers the same way.
        const sharedReads = () => {
          const reads = {
            remotes: commands.filter((command) => command === "remote").length,
            remoteHead: commands.filter((command) => command.endsWith("refs/remotes/origin/HEAD"))
              .length,
          };
          commands.length = 0;
          return reads;
        };

        for (const index of [0, 1, 2]) yield* lookup(index);
        assert.deepEqual(sharedReads(), { remotes: 1, remoteHead: 1 });

        // Another checkout repoints the remote; every worktree sees the new common config.
        yield* runGit(repo, [
          "remote",
          "set-url",
          "origin",
          "https://github.com/example/moved.git",
        ]);
        yield* Effect.result(lookup(1));
        assert.deepEqual(sharedReads(), { remotes: 1, remoteHead: 1 });
        yield* Effect.result(lookup(2));
        assert.deepEqual(sharedReads(), { remotes: 0, remoteHead: 0 });

        yield* lookup(0, { refresh: true });
        assert.deepEqual(sharedReads(), { remotes: 1, remoteHead: 1 });
        yield* manager.invalidateStatus(worktrees[0]!);
        yield* lookup(2);
        assert.deepEqual(sharedReads(), { remotes: 1, remoteHead: 1 });
      }).pipe(Effect.scoped),
  );
});
