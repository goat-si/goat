// @effect-diagnostics nodeBuiltinImport:off -- inspect the body file the real manager creates.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { SourceControlProviderError } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeTempDir } from "./testkit/fileFixtures.ts";
import { runGit, initRepo } from "./testkit/gitRepository.ts";
import {
  createBareRemote,
  createFakeSourceControlProvider,
  layerGitManagerTest,
  makeManager,
  runStackedAction,
} from "./GitManagerTestHarness.ts";

it.layer(layerGitManagerTest)("pull request body cleanup", (it) => {
  it.effect("removes the generated body file after provider failure", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("goat-pr-body-cleanup-");
      yield* initRepo(cwd);
      yield* runGit(cwd, ["checkout", "-b", "feature/body-cleanup"]);
      const remote = yield* createBareRemote();
      yield* runGit(cwd, ["remote", "add", "origin", remote]);
      NodeFS.writeFileSync(NodePath.join(cwd, "change.txt"), "change\n");
      yield* runGit(cwd, ["add", "change.txt"]);
      yield* runGit(cwd, ["commit", "-m", "Add change"]);
      yield* runGit(cwd, ["push", "-u", "origin", "feature/body-cleanup"]);
      const { service } = createFakeSourceControlProvider({ kind: "gitlab" });
      let bodyFile: string | undefined;
      const { manager } = yield* makeManager({
        sourceControlProvider: {
          ...service,
          createChangeRequest: (input) =>
            Effect.suspend(() => {
              bodyFile = input.bodyFile;
              return Effect.fail(
                new SourceControlProviderError({
                  provider: service.kind,
                  operation: "createChangeRequest",
                  cwd: input.cwd,
                  detail: "stdin write failed",
                }),
              );
            }),
        },
      });
      const result = yield* runStackedAction(manager, { cwd, action: "create_pr" }).pipe(
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(bodyFile).toBeDefined();
      expect(bodyFile && NodeFS.existsSync(bodyFile)).toBe(false);
    }),
  );
});
