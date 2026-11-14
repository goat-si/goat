import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("push diagnostics", (it) => {
  it.effect("explains a non-fast-forward push from a host with a translated Git", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      const other = yield* makeTmpDir("git-other-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "--set-upstream", "origin", initialBranch]);
      yield* git(other, ["clone", "--branch", initialBranch, remote, "."]);
      yield* git(other, [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=T",
        "commit",
        "--allow-empty",
        "-m",
        "remote",
      ]);
      yield* git(other, ["push", "origin", initialBranch]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "local"]);
      const locales: Array<string | undefined> = [];
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("push")) {
          locales.push(command.options.env?.LANGUAGE);
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("LANGUAGE", "de")),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );

      const error = yield* driver.pushCurrentBranch(cwd, null).pipe(Effect.flip);

      assert.equal(error.reason, "push_rejected_non_fast_forward");
      assert.isNotEmpty(locales);
      for (const locale of locales) assert.equal(locale, "C");
    }),
  );
});
