import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import {
  createBareRemote,
  layerGitManagerTest,
  listedSelectors,
  makeManager,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager base PR lookup", (it) => {
  it.effect(
    "status does not inherit a release PR from a worktree's non-default base upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("goat-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["push", "origin", "main:dev"]);
        yield* runGit(repoDir, ["fetch", "origin"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/from-dev", "origin/dev"]);
        yield* runGit(repoDir, ["config", "branch.feature/from-dev.t3-merge-base", "dev"]); // goat-rename: legacy
        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            prListByHeadSelector: {
              dev: [
                {
                  number: 49,
                  title: "Release dev to main",
                  url: "https://github.com/example/repo/pull/49",
                  baseRefName: "main",
                  headRefName: "dev",
                  state: "merged",
                  updatedAt: "2026-08-20T10:00:00Z",
                },
              ],
            },
          },
        });
        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("feature/from-dev");
        expect(status.pr).toBeNull();
        expect(listedSelectors(providerCalls).includes("dev")).toBe(false);
      }),
  );
});
