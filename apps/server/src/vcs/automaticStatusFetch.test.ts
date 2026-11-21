import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { VcsAutomaticFetchInterval } from "./vcsBackgroundPolicy.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
} from "./testing/gitFixture.ts";

it.effect("disables automatic status fetching at a zero interval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetches: string[][] = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch"))
          fetches.push(command.args.map(String));
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(VcsAutomaticFetchInterval, Effect.succeed(Duration.zero)),
        Effect.provide(layerServerConfig),
      );
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "--set-upstream", "origin", initialBranch]);
      const status = yield* driver.statusDetailsRemote(cwd);
      assert.equal(status.upstreamRef, `origin/${initialBranch}`);
      assert.deepStrictEqual(fetches, []);
    }),
  ).pipe(Effect.provide(layerTest)),
);
