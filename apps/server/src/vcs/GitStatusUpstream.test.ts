import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import {
  layerTest,
  layerServerConfig,
  makeTmpDir,
  initRepoWithCommit,
  git,
} from "./testing/gitFixture.ts";

it.effect("does not fetch for status when the branch tracks a local branch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fetches: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch")) {
          fetches.push(command.args.map(String));
        }
        return delegate.spawn(command);
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "feature", remote]);
      yield* git(cwd, ["branch", "feature/base"]);
      yield* git(cwd, ["checkout", "-b", "stacked", "--track", "feature/base"]);

      const status = yield* driver.statusDetailsRemote(cwd);

      assert.equal(status.upstreamRef, "feature/base");
      assert.deepStrictEqual(fetches, []);
    }),
  ).pipe(
    Effect.provide(
      Layer.merge(layerTest, layerServerConfig.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
);
