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
  configureVisibleRemoteUrlWithLocalRewrite,
  runStackedAction,
  makeManager,
  layerGitManagerTest,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("GitManager default-branch push guard", (it) => {
  it.effect.each([
    { localBranch: "develop" },
    // Pushes to origin's develop under a name that differs from the base.
    { localBranch: "origin/develop" },
  ] as const)(
    "commit_push_pr refuses to commit or push on the default branch when origin/HEAD is missing ($localBranch)",
    ({ localBranch }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("goat-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["branch", "-m", "main", "develop"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "develop"]);
        if (localBranch !== "develop") yield* runGit(repoDir, ["checkout", "-b", localBranch]);
        const readRemoteDevelop = runGit(repoDir, [
          "ls-remote",
          "origin",
          "refs/heads/develop",
        ]).pipe(Effect.map((output) => output.stdout));
        const remoteBefore = yield* readRemoteDevelop;
        const localBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;
        NodeFS.writeFileSync(NodePath.join(repoDir, "change.txt"), "change\n");

        const { manager } = yield* makeManager({
          providerScenario: { defaultBranch: "develop", prListSequence: [[], []] },
        });

        const error = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        }).pipe(Effect.flip);

        expect(yield* readRemoteDevelop).toBe(remoteBefore);
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(localBefore);
        expect(error.message).toContain("develop is the base branch");
      }),
  );

  it.effect("commit_push_pr on the default branch returns its open PR into another base", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      const releasePr = {
        number: 43,
        title: "Release",
        url: "https://github.com/pingdotgg/codething-mvp/pull/43",
        baseRefName: "release",
        headRefName: "main",
      };

      const { manager } = yield* makeManager({
        providerScenario: { defaultBranch: "main", prListSequence: [[releasePr], [releasePr]] },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(43);
    }),
  );

  it.effect(
    "commit_push_pr publishes a branch that tracks the default branch under its own name",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("goat-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["branch", "-m", "main", "develop"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "develop"]);
        yield* runGit(repoDir, ["checkout", "-b", "goat/feature", "--track", "origin/develop"]);
        const readRemoteDevelop = runGit(repoDir, [
          "ls-remote",
          "origin",
          "refs/heads/develop",
        ]).pipe(Effect.map((output) => output.stdout));
        const remoteBefore = yield* readRemoteDevelop;
        NodeFS.writeFileSync(NodePath.join(repoDir, "change.txt"), "change\n");

        const { manager, providerCalls } = yield* makeManager({
          providerScenario: {
            defaultBranch: "develop",
            prListSequence: [
              [],
              [
                {
                  number: 506,
                  title: "Feature",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/506",
                  baseRefName: "develop",
                  headRefName: "goat/feature",
                },
              ],
            ],
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("created");
        expect(yield* readRemoteDevelop).toBe(remoteBefore);
        expect(
          created(providerCalls).some(
            (call) => call.baseRefName === "develop" && call.headSelector === "goat/feature",
          ),
        ).toBe(true);
      }),
  );

  it.effect("commit_push_pr publishes the default branch to the push remote's fork", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("goat-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["push", "fork", "main"]);
      yield* runGit(repoDir, ["config", "remote.pushDefault", "fork"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.com:octocat/codething-mvp.git",
        forkDir,
      );
      const readOriginMain = runGit(repoDir, ["ls-remote", "origin", "refs/heads/main"]).pipe(
        Effect.map((output) => output.stdout),
      );
      const originBefore = yield* readOriginMain;
      NodeFS.writeFileSync(NodePath.join(repoDir, "change.txt"), "change\n");

      const { manager, providerCalls } = yield* makeManager({
        providerScenario: {
          defaultBranch: "main",
          prListSequenceByHeadSelector: {
            "octocat:main": [
              [],
              [
                {
                  number: 189,
                  title: "Contribute from main",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/189",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "open",
                  isCrossRepository: true,
                  headRepositoryNameWithOwner: "octocat/codething-mvp",
                  headRepositoryOwnerLogin: "octocat",
                },
              ],
            ],
          },
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(yield* readOriginMain).toBe(originBefore);
      expect(
        created(providerCalls).some(
          (call) => call.baseRefName === "main" && call.headSelector === "octocat:main",
        ),
      ).toBe(true);
    }),
  );
});
