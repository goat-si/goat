// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";

import {
  created,
  createBareRemote,
  createFakeSourceControlProvider,
  configureVisibleRemoteUrlWithLocalRewrite,
  listedSelectors,
  runStackedAction,
  makeManager,
  layerGitManagerTest,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager fork pull requests", (it) => {
  it.effect("creates a fork PR from origin into the upstream remote the provider targets", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", forkDir]);
      yield* runGit(repoDir, [
        "remote",
        "add",
        "upstream",
        "git@github.com:pingdotgg/codething-mvp.git",
      ]);
      yield* runGit(repoDir, ["config", "remote.upstream.gh-resolved", "base"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/fork-only"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork-only.txt"), "fork only\n");
      yield* runGit(repoDir, ["add", "fork-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork-only commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/fork-only"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:octocat/codething-mvp.git",
        forkDir,
      );

      const { service, calls } = createFakeSourceControlProvider({ prListSequence: [[], []] });
      const { manager } = yield* makeManager({
        sourceControlProvider: {
          ...service,
          createsChangeRequestsIn: ({ repository }) =>
            Effect.succeed(repository === "pingdotgg/codething-mvp"),
        },
      });
      const result = yield* runStackedAction(manager, { cwd: repoDir, action: "create_pr" });

      expect(result.pr.status).toBe("created");
      expect(created(calls)).toEqual([
        { baseRefName: "main", headSelector: "octocat:feature/fork-only" },
      ]);
    }),
  );

  it.effect("branch PR lookup in a fork checkout follows the branch's own published ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", forkDir]);
      yield* runGit(repoDir, [
        "remote",
        "add",
        "upstream",
        "git@github.com:pingdotgg/codething-mvp.git",
      ]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      // What a new worktree thread gets: its start point as upstream, nothing published.
      yield* runGit(repoDir, ["branch", "--track", "goat/new-thread", "origin/main"]);
      yield* runGit(repoDir, ["branch", "--track", "feature/published", "origin/main"]);
      yield* runGit(repoDir, ["branch", "--track", "t3code/pr-300/main", "origin/main"]);
      yield* runGit(repoDir, ["branch", "--track", "goat-pr-300-main", "origin/main"]);
      yield* runGit(repoDir, ["push", "origin", "feature/published"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const forkPullRequest = {
        baseRefName: "main",
        isCrossRepository: true,
        headRepositoryNameWithOwner: "contributor/codething-mvp",
        headRepositoryOwnerLogin: "contributor",
      } as const;
      const { service, calls } = createFakeSourceControlProvider({
        prListByHeadSelector: {
          "contributor:main": [
            {
              ...forkPullRequest,
              number: 300,
              title: "Fork main",
              url: "https://github.com/pingdotgg/codething-mvp/pull/300",
              headRefName: "main",
              state: "merged",
            },
          ],
          "feature/published": [
            {
              ...forkPullRequest,
              number: 224,
              title: "Fork feature",
              url: "https://github.com/pingdotgg/codething-mvp/pull/224",
              headRefName: "feature/published",
              state: "open",
            },
          ],
        },
      });
      const { manager } = yield* makeManager({
        sourceControlProvider: {
          ...service,
          createsChangeRequestsIn: ({ repository }) =>
            Effect.succeed(repository === "pingdotgg/codething-mvp"),
        },
      });

      const unpublished = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "goat/new-thread",
      });
      expect(unpublished).toBeNull();
      expect(listedSelectors(calls)).toEqual([]);

      const published = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/published",
      });
      expect(published?.number).toBe(224);

      for (const branch of ["t3code/pr-300/main", "goat-pr-300-main"]) {
        const pullRequestWorktree = yield* manager.branchPullRequest({ cwd: repoDir, branch });
        expect(pullRequestWorktree?.number).toBe(300);
      }
    }),
  );
});
