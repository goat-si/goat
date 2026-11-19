import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { makeSuccessfulHandle, makeFailedHandle } from "./testing/configLockRegression.ts";
import {
  layerServerConfig,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.effect("commits selected files with git that rejects --pathspec-from-file", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Git before 2.25 has no `add --pathspec-from-file` and exits with a usage error.
      const oldGitSpawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die("expected a standard Git command");
        }
        if (command.args.at(-1) === "version") {
          return Effect.succeed(makeSuccessfulHandle("git version 2.24.4\n"));
        }
        if (command.args.some((arg) => String(arg).startsWith("--pathspec-from-file"))) {
          return Effect.succeed(makeFailedHandle("error: unknown option `pathspec-from-file=-'"));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, oldGitSpawner),
      );
      yield* Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const selected = ["selected[1].txt", "-dash.txt", "with space.txt"];
        for (const file of selected) yield* writeTextFile(cwd, file, "selected\n");
        yield* writeTextFile(cwd, "left.txt", "left\n");

        yield* driver.commit(cwd, "Selected", "", { stage: { filePaths: selected } });

        assert.sameMembers(
          (yield* git(cwd, ["show", "--pretty=", "--name-only", "-z", "HEAD"]))
            .split("\0")
            .filter(Boolean),
          selected,
        );
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "?? left.txt");
      }).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, driver));
    }),
  ).pipe(
    Effect.provide(
      layerServerConfig.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
