import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";

export const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-git-vcs-driver-test-",
});
export const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(NodeServices.layer),
);

export const makeTmpDir = Effect.fn("test.makeTmpDir")(function* (prefix = "git-vcs-driver-test-") {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

export const writeTextFile = Effect.fn("test.writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

export const git = Effect.fn("GitVcsDriver.test.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "GitVcsDriver.test.git",
    cwd,
    args,
    ...(env ? { env } : {}),
    timeoutMs: 10_000,
  });
  return result.stdout.trim();
});

export const initRepoWithCommit = Effect.fn("test.initRepoWithCommit")(function* (cwd: string) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  yield* driver.initRepo({ cwd });
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* writeTextFile(cwd, "README.md", "# test\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial commit"]);
  const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
  return { initialBranch };
});
