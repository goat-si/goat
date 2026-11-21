import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import {
  type FakeChangeRequest,
  listed,
  createBareRemote,
  configureVisibleRemoteUrlWithLocalRewrite,
  makeManager,
  layerGitManagerTest,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager owner probe", (it) => {
  it.effect("finds a fork branch's open PR past a full page of other forks' PRs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature"]);
      yield* runGit(repoDir, ["push", "-u", "fork", "feature"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:team/repository.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.com:alice/repository.git",
        forkDir,
      );
      const otherForks: FakeChangeRequest[] = Array.from({ length: 100 }, (_, index) => ({
        number: 200 - index,
        title: "Update docs",
        url: `https://github.com/team/repository/pull/${200 - index}`,
        baseRefName: "main",
        headRefName: "feature",
        state: "open",
        isCrossRepository: true,
        headRepositoryNameWithOwner: `fork-${index + 1}/repository`,
        headRepositoryOwnerLogin: `fork-${index + 1}`,
      }));
      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          prListSequenceByHeadSelector: { feature: [otherForks, otherForks] },
          prListByHeadSelector: {
            "alice:feature": [
              {
                number: 1,
                title: "This fork",
                url: "https://github.com/team/repository/pull/1",
                baseRefName: "main",
                headRefName: "feature",
                state: "open",
                isCrossRepository: true,
                headRepositoryNameWithOwner: "alice/repository",
                headRepositoryOwnerLogin: "alice",
              },
            ],
          },
        },
      });

      expect(yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature" })).toMatchObject({
        number: 1,
        state: "open",
      });
      expect(listed(providerCalls).map((call) => [call.headSelector, call.state])).toEqual([
        ["feature", "all"],
        ["alice:feature", "open"],
      ]);
    }),
  );
});
