import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { BackgroundGitWork, TargetedSettlementGitWork } from "../vcs/BackgroundGitWork.ts";
import { layerGitManagerTest, listed, makeManager } from "./GitManagerTestHarness.ts";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { initRepo, runGit } from "./testkit/gitRepository.ts";

it.layer(layerGitManagerTest)("GitManager priority", (it) => {
  it.effect("shares completed PR lookups across lanes and refreshes them together", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("goat-git-pr-priority-");
      yield* initRepo(cwd);
      yield* runGit(cwd, ["remote", "add", "origin", "https://github.com/example/project.git"]);
      yield* runGit(cwd, ["checkout", "-b", "feature/priority"]);
      yield* runGit(cwd, ["config", "branch.feature/priority.remote", "origin"]);
      yield* runGit(cwd, [
        "config",
        "branch.feature/priority.merge",
        "refs/heads/feature/priority",
      ]);
      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListOtherwise: [
            {
              number: 42,
              title: "Open",
              url: "https://github.com/example/project/pull/42",
              baseRefName: "main",
              headRefName: "feature/priority",
            },
          ],
        },
      });
      const input = { cwd, branch: "feature/priority" };
      const background = manager
        .branchPullRequest(input)
        .pipe(Effect.provideService(BackgroundGitWork, true));
      const targeted = manager
        .branchPullRequest(input)
        .pipe(Effect.provideService(TargetedSettlementGitWork, true));
      yield* background;
      const initial = listed(providerCalls).length;
      expect(initial).toBeGreaterThan(0);
      yield* targeted;
      expect(listed(providerCalls)).toHaveLength(initial);
      yield* manager
        .branchPullRequest(input, { refresh: true })
        .pipe(Effect.provideService(TargetedSettlementGitWork, true));
      const refreshed = listed(providerCalls).length;
      expect(refreshed).toBeGreaterThan(initial);
      yield* background;
      expect(listed(providerCalls)).toHaveLength(refreshed);
    }),
  );
});
