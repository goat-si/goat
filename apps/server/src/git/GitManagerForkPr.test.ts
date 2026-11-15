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
});
