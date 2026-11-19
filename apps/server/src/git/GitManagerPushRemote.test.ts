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

it.layer(layerGitManagerTest)("push remote", (it) => {
  it.effect(
    "create_pr publishes to the push remote when the tracked upstream already has HEAD",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "topic"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
        yield* runGit(repoDir, ["add", "changes.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Topic change"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "topic"]);
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
        yield* runGit(repoDir, ["config", "remote.pushDefault", "fork"]);

        const { manager, providerCalls } = yield* makeManager();
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "create_pr",
        });

        expect(result.push).toMatchObject({ status: "pushed", upstreamBranch: "fork/topic" });
        expect(result.pr.status).toBe("created");
        expect(
          yield* runGit(forkDir, ["--git-dir=.", "log", "-1", "--pretty=%s", "topic"]),
        ).toMatchObject({
          stdout: "Topic change\n",
        });
        expect(created(providerCalls)).toEqual([
          { baseRefName: "main", headSelector: "octocat:topic" },
        ]);
        expect(yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toMatchObject({
          stdout: "origin/topic\n",
        });
      }),
  );
});
