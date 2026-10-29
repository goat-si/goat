import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "../GitVcsDriverCore.ts";
import { git, initRepoWithCommit, layerServerConfig, makeTmpDir } from "./gitFixture.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";

export const parallelWorktreeRegression = Effect.gen(function* () {
  const cwd = yield* makeTmpDir();
  const { initialBranch } = yield* initRepoWithCommit(cwd);
  const remote = yield* makeTmpDir("git-remote-");
  yield* git(remote, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["push", "origin", initialBranch]);
  const path = yield* Path.Path;
  const root = yield* makeTmpDir("git-worktrees-");
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const branches = Array.from({ length: 4 }, (_, index) => `feature/parallel-${index}`);
  yield* Effect.forEach(
    branches,
    (branch, index) =>
      driver.createWorktree({
        cwd,
        path: path.join(root, `worktree-${index}`),
        refName: `origin/${initialBranch}`,
        newRefName: branch,
        baseRefName: `origin/${initialBranch}`,
      }),
    { concurrency: "unbounded" },
  );
  yield* Effect.forEach(
    branches,
    (branch, index) =>
      driver.renameBranch({
        cwd: path.join(root, `worktree-${index}`),
        oldBranch: branch,
        newBranch: `${branch}-renamed`,
        exactName: true,
      }),
    { concurrency: "unbounded" },
  );
  for (const branch of branches) {
    assert.equal(yield* git(cwd, ["config", `branch.${branch}-renamed.remote`]), "origin");
    assert.equal(
      yield* git(cwd, ["config", `branch.${branch}-renamed.t3-merge-base-ref`]),
      `refs/remotes/origin/${initialBranch}`,
    );
  }
});

export const makeNonRepositoryHandle = () =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(128)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make("fatal: not a git repository")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
export const makeSuccessfulHandle = (stdout: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    stdout: Stream.encodeText(Stream.make(stdout)),
    stderr: Stream.empty,
  });
export const makeFailedHandle = (stderr: string) =>
  ChildProcessSpawner.makeHandle({
    ...makeNonRepositoryHandle(),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
    stderr: Stream.encodeText(Stream.make(stderr)),
  });

export const pushLockRegression = Effect.gen(function* () {
  const cwd = yield* makeTmpDir();
  const remote = yield* makeTmpDir("git-remote-");
  yield* initRepoWithCommit(cwd);
  yield* git(remote, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["checkout", "-q", "-b", "feature/locked"]);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(cwd, ".git", "config.lock"), "");
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const pushed = yield* TestClock.withLive(driver.pushCurrentBranch(cwd, null));
  assert.deepInclude(pushed, { status: "pushed", setUpstream: false });
  assert.include(
    yield* git(cwd, ["ls-remote", "origin", "refs/heads/feature/locked"]),
    yield* git(cwd, ["rev-parse", "HEAD"]),
  );
  assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/locked.remote"), null);
});

export const remoteLockRegression = Effect.gen(function* () {
  const cwd = yield* makeTmpDir();
  yield* git(cwd, ["init"]);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const lockPath = path.join(cwd, ".git", "config.lock");
  yield* fs.writeFileString(lockPath, "");
  const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failures = yield* Ref.make(0);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* delegate.spawn(command);
      if (
        !ChildProcess.isStandardCommand(command) ||
        command.args[0] !== "remote" ||
        command.args[1] !== "add"
      )
        return handle;
      return ChildProcessSpawner.makeHandle({
        ...handle,
        exitCode: handle.exitCode.pipe(
          Effect.tap((code) =>
            code === 0
              ? Effect.void
              : Ref.update(failures, (n) => n + 1).pipe(
                  Effect.andThen(fs.remove(lockPath, { force: true })),
                  Effect.orDie,
                ),
          ),
        ),
      });
    }),
  );
  const driver = yield* makeGitVcsDriverCore().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(layerServerConfig),
  );
  const url = "https://github.com/example/project.git";
  assert.equal(
    yield* TestClock.withLive(driver.ensureRemote({ cwd, preferredName: "fork", url })),
    "fork",
  );
  assert.equal(yield* Ref.get(failures), 1);
  assert.equal(yield* git(cwd, ["remote", "get-url", "fork"]), url);
});

export const trackingWorktreeLockRegression = Effect.gen(function* () {
  const cwd = yield* makeTmpDir();
  const { initialBranch } = yield* initRepoWithCommit(cwd);
  const remote = yield* makeTmpDir("git-remote-");
  yield* git(remote, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["push", "origin", initialBranch]);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const lockPath = path.join(cwd, ".git", "config.lock");
  yield* fs.writeFileString(lockPath, "");
  const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failures = yield* Ref.make(0);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const handle = yield* delegate.spawn(command);
      if (!ChildProcess.isStandardCommand(command)) return handle;
      const args = command.args;
      if (
        !(args.includes("worktree") && args.includes("add")) &&
        !args.some((arg) => arg.startsWith("--set-upstream-to"))
      )
        return handle;
      return ChildProcessSpawner.makeHandle({
        ...handle,
        exitCode: handle.exitCode.pipe(
          Effect.tap((code) =>
            code === 0
              ? Effect.void
              : Ref.update(failures, (n) => n + 1).pipe(
                  Effect.andThen(fs.remove(lockPath, { force: true })),
                  Effect.orDie,
                ),
          ),
        ),
      });
    }),
  );
  const driver = yield* makeGitVcsDriverCore().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(layerServerConfig),
  );
  const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "tracked");
  yield* TestClock.withLive(
    driver.createWorktree({
      cwd,
      path: worktreePath,
      refName: `origin/${initialBranch}`,
      newRefName: "feature/tracked",
    }),
  );
  assert.equal(yield* Ref.get(failures), 1);
  assert.equal(
    yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature/tracked@{upstream}"]),
    `origin/${initialBranch}`,
  );
});
