import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerServerConfig,
  layerTest,
  makeTmpDir,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.effect.each(["root", "nested", "worktree"] as const)(
  "coalesces config reads and sees external config changes from a %s directory",
  (location) =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      yield* initRepoWithCommit(root);
      let cwd = root;
      if (location === "nested") {
        cwd = `${root}/nested`;
        yield* (yield* FileSystem.FileSystem).makeDirectory(cwd);
      } else if (location === "worktree") {
        cwd = yield* makeTmpDir();
        yield* git(root, ["worktree", "add", "--detach", cwd]);
      }
      yield* git(root, ["config", "remote.origin.url", "https://github.com/example/first.git"]);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      let configSpawns = 0;
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "config")
              configSpawns++;
            return delegate.spawn(command);
          }),
        ),
      );
      const read = driver.readConfigValue(cwd, "remote.origin.url");
      const values = yield* Effect.all(
        Array.from({ length: 10 }, () => read),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(values, Array(10).fill("https://github.com/example/first.git"));
      yield* Effect.all(
        Array.from({ length: 10 }, () => read),
        { concurrency: 1 },
      );
      assert.equal(configSpawns, 1);
      yield* git(root, ["config", "remote.origin.url", "https://github.com/example/second.git"]);
      assert.equal(yield* read, "https://github.com/example/second.git");
      assert.equal(configSpawns, 2);
      assert.isNull(yield* driver.readConfigValue(cwd, "probe.missing"));
      yield* git(root, ["config", "probe.missing", "added"]);
      assert.equal(yield* driver.readConfigValue(cwd, "probe.missing"), "added");
      const included = `${root}/included-config`;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(included, "[probe]\nvalue = first\n");
      yield* git(root, ["config", "include.path", included]);
      assert.equal(yield* driver.readConfigValue(cwd, "probe.value"), "first");
      yield* fs.writeFileString(included, "[probe]\nvalue = second\n");
      yield* TestClock.adjust("1 second");
      assert.equal(yield* driver.readConfigValue(cwd, "probe.value"), "second");
    }).pipe(Effect.scoped, Effect.provide(layerServerConfig.pipe(Layer.provideMerge(layerTest)))),
);

it.effect("config reads follow per-worktree config changes immediately", () =>
  Effect.gen(function* () {
    const root = yield* makeTmpDir();
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(root);
    yield* git(root, ["worktree", "add", "--detach", cwd]);
    yield* git(root, ["config", "extensions.worktreeConfig", "true"]);
    yield* git(cwd, ["config", "--worktree", "probe.value", "first"]);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    assert.equal(yield* driver.readConfigValue(cwd, "probe.value"), "first");
    yield* git(cwd, ["config", "--worktree", "probe.value", "second"]);
    assert.equal(yield* driver.readConfigValue(cwd, "probe.value"), "second");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
