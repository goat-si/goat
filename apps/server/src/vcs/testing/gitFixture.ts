import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterAll } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off -- afterAll cleanup runs outside Effect.
import * as NodeFS from "node:fs";
import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../GitVcsDriver.ts";

export const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-git-vcs-driver-test-",
});
export const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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

const commitInitialRepo = Effect.fn("test.commitInitialRepo")(function* (cwd: string) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  yield* driver.initRepo({ cwd });
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* writeTextFile(cwd, "README.md", "# test\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial commit"]);
});

// Most tests start from the same one-commit repository; they copy it instead of spawning git.
let repoTemplate: string | undefined;
afterAll(() => {
  if (repoTemplate) NodeFS.rmSync(repoTemplate, { recursive: true, force: true });
});

export const initRepoWithCommit = Effect.fn("test.initRepoWithCommit")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Git commits whatever already sits in cwd, so only an empty one can take the shared copy.
  const empty =
    !(yield* fileSystem.exists(cwd)) || (yield* fileSystem.readDirectory(cwd)).length === 0;
  if (empty) {
    if (!repoTemplate) {
      const template = yield* fileSystem.makeTempDirectory({ prefix: "git-vcs-driver-template-" });
      yield* commitInitialRepo(template);
      repoTemplate = template;
    }
    yield* fileSystem.copy(repoTemplate, cwd);
  } else {
    yield* commitInitialRepo(cwd);
  }
  const head = yield* fileSystem.readFileString(path.join(cwd, ".git", "HEAD"));
  return { initialBranch: head.trim().replace(/^ref: refs\/heads\//, "") };
});
