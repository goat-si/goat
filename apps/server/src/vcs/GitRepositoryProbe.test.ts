import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-probe-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({ operation: "GitVcsDriver.contract.git", cwd, args, timeoutMs: 10_000 });
  });

it.effect("GitVcsDriver fails repository probes when git cannot read the repository config", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-bad-config-" });
    // The included file's path appears in Git's message and must not read as "no repository".
    const includeDir = path.join(root, "not a git repository");
    yield* fileSystem.makeDirectory(includeDir);
    yield* fileSystem.writeFileString(path.join(includeDir, "included"), "invalid config\n");
    const configs = {
      direct: "invalid config\n",
      included: `[include]\n\tpath = ${path.join(includeDir, "included")}\n`,
    };
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const checkpointRef = CheckpointRef.make("refs/goat/checkpoints/bad-config/0");

    for (const [name, config] of Object.entries(configs)) {
      const cwd = path.join(root, name);
      yield* fileSystem.makeDirectory(cwd);
      yield* runGit(cwd, ["init"]);
      yield* fileSystem.writeFileString(path.join(cwd, ".git", "config"), config);
      const outcomes = {
        isInsideWorkTree: Exit.isFailure(yield* Effect.exit(driver.isInsideWorkTree(cwd))),
        detectRepository: Exit.isFailure(yield* Effect.exit(driver.detectRepository(cwd))),
        hasCheckpointRef: Exit.isFailure(
          yield* Effect.exit(driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef })),
        ),
      };
      assert.deepStrictEqual(
        outcomes,
        { isInsideWorkTree: true, detectRepository: true, hasCheckpointRef: true },
        `a bad ${name} config is an operational failure, not an absent repository or ref`,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("GitVcsDriver reports no repository for a deleted cwd or a bare repository", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-no-work-tree-" });
    const bare = path.join(root, "bare.git");
    yield* fileSystem.makeDirectory(bare);
    yield* runGit(bare, ["init", "--bare"]);
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    for (const cwd of [path.join(root, "deleted"), bare]) {
      assert.equal(yield* driver.isInsideWorkTree(cwd), false, cwd);
      assert.equal(yield* driver.detectRepository(cwd), null, cwd);
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// Git outputs CI's Git version cannot produce with a real repository.
const makeStubbedDriver = Effect.fn("test.makeStubbedDriver")(function* (output: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}) {
  const process = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () =>
        Effect.succeed({
          ...output,
          code: ChildProcessSpawner.ExitCode(output.code),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    }),
  );
  return yield* GitVcsDriver.makeVcsDriverShape().pipe(
    Effect.provideService(VcsProcess.VcsProcess, process),
  );
});

it.effect("GitVcsDriver reports no repository when old Git answers false before failing", () =>
  Effect.gen(function* () {
    // Git before 2.38 ignores safe.bareRepository, so a bare repo prints "false" and exits 128.
    const driver = yield* makeStubbedDriver({
      code: 128,
      stdout: "false\n",
      stderr: "fatal: this operation must be run in a work tree\n",
    });

    assert.equal(yield* driver.detectRepository(globalThis.process.cwd()), null);
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("GitVcsDriver fails a checkpoint ref lookup when git cannot read its object", () =>
  Effect.gen(function* () {
    const driver = yield* makeStubbedDriver({
      code: 1,
      stdout: "",
      stderr: "error: unable to open loose object 0733271782d6: Permission denied\n",
    });
    const checkpointRef = CheckpointRef.make("refs/goat/checkpoints/unreadable/0");

    const exit = yield* Effect.exit(
      driver.checkpoints.hasCheckpointRef({ cwd: globalThis.process.cwd(), checkpointRef }),
    );
    assert.isTrue(Exit.isFailure(exit), "an unreadable checkpoint object is not an absent ref");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("GitVcsDriver reads an absent checkpoint ref as absent despite a Git warning", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-git-warning-" });
    yield* runGit(cwd, ["init"]);
    // Valid legacy config that makes every Git command print a deprecation warning.
    yield* runGit(cwd, ["config", "core.fsyncObjectFiles", "true"]);
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const checkpointRef = CheckpointRef.make("refs/goat/checkpoints/absent/0");

    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
