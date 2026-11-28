import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-git-vcs-path-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "GitVcsDriver keeps whitespace at the end of repository paths",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-edge-space-repo-" });
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      // The newline name takes the per-path fallback; the others take the one-spawn answer.
      for (const name of ["repo ", "repo\r", "multi\nline "]) {
        const cwd = path.join(parent, name);
        const gitDir = path.join(parent, `${name.replace("\n", "")} metadata\u00a0`);
        yield* fileSystem.makeDirectory(cwd);
        yield* runGit(cwd, ["init", `--separate-git-dir=${gitDir}`]);

        const repository = yield* driver.detectRepository(cwd);
        assert.strictEqual(repository?.rootPath, yield* fileSystem.realPath(cwd));
        assert.strictEqual(repository?.metadataPath, yield* fileSystem.realPath(gitDir));
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "checkpoint capture keeps whitespace at the end of Git paths",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-edge-space-capture-",
      });
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "test",
          cwd,
          args: ["-c", "user.name=Test", "-c", "user.email=test@test.com", ...args],
        });
      const library = path.join(parent, "library");
      yield* fileSystem.makeDirectory(library);
      yield* git(library, ["init"]);
      yield* git(library, ["commit", "--allow-empty", "-m", "initial"]);
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/edge-space");
      // The newline name takes the per-path fallback; the other takes the one-spawn answer.
      for (const name of ["repo ", "multi\nline "]) {
        const cwd = path.join(parent, name);
        yield* fileSystem.makeDirectory(cwd);
        yield* git(cwd, ["init", `--separate-git-dir=${path.join(parent, `${name.trim()} git `)}`]);
        yield* git(cwd, ["-c", "protocol.file.allow=always", "submodule", "add", library, "lib"]);
        yield* git(cwd, ["commit", "-m", "initial"]);
        yield* fileSystem.writeFileString(path.join(cwd, "dirty.txt"), "pending\n");
        yield* fileSystem.writeFileString(path.join(cwd, "lib", "dirty.txt"), "nested\n");

        yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

        assert.strictEqual(
          (yield* git(cwd, ["show", `${checkpointRef}:dirty.txt`])).stdout,
          "pending\n",
        );
        assert.strictEqual(
          (yield* git(path.join(cwd, "lib"), ["show", `${checkpointRef}:dirty.txt`])).stdout,
          "nested\n",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
