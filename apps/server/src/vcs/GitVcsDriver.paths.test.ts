import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
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
