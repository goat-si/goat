import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import {
  configureVisibleRemoteUrlWithLocalRewrite,
  createBareRemote,
  layerGitManagerTest,
  makeManager,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("first fetch URL", (it) => {
  it.effect("keeps status and PR matching on the first URL", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("goat-first-remote-");
      yield* initRepo(cwd);
      yield* runGit(cwd, ["checkout", "-b", "feature/mirrored"]);
      const remote = yield* createBareRemote();
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      yield* runGit(cwd, ["push", "-u", "origin", "feature/mirrored"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        cwd,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        remote,
      );
      yield* runGit(cwd, [
        "config",
        "--add",
        "remote.origin.url",
        "git@gitlab.com:mirror-owner/codething-mvp.git",
      ]);
      const { manager } = yield* makeManager({
        providerScenario: {
          prListSequence: [
            [
              {
                number: 16,
                title: "Mirrored branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/16",
                baseRefName: "main",
                headRefName: "feature/mirrored",
                isCrossRepository: false,
                headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
                headRepositoryOwnerLogin: "pingdotgg",
              },
            ],
          ],
        },
      });
      const status = yield* manager.status({ cwd });
      expect(status.sourceControlProvider?.kind).toBe("github");
      expect(status.pr?.number).toBe(16);
    }),
  );
});
