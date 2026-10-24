import * as NodeServices from "@effect/platform-node/NodeServices";
import { GOAT_PROJECT_FILE_NAME } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-submodule-worktree-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = Effect.fn(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "GitVcsDriver.test.git",
    cwd,
    args: ["-c", "user.email=test@test.com", "-c", "user.name=Test", ...args],
    timeoutMs: 10_000,
  });
  return result.stdout.trim();
});

const commitFiles = Effect.fn(function* (cwd: string, files: Record<string, string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(cwd, { recursive: true });
  yield* git(cwd, ["init", "-q"]);
  for (const [name, contents] of Object.entries(files)) {
    yield* fileSystem.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
    yield* fileSystem.writeFileString(path.join(cwd, name), contents);
  }
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-q", "-m", "files"]);
});

it.layer(layerTest)("worktrees of a submodule checkout", (it) => {
  it.effect.each(["sparse", "full"] as const)(
    "a %s worktree checks out into its own directory and leaves the submodule's config alone (#799)",
    (mode) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const root = yield* fileSystem.realPath(
          yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-submodule-worktree-" }),
        );
        const inner = path.join(root, "inner");
        const superproject = path.join(root, "super");
        yield* commitFiles(inner, {
          "src/app.ts": "export {};\n",
          ".repos/vendor/big.ts": "export {};\n",
          ...(mode === "sparse"
            ? { [GOAT_PROJECT_FILE_NAME]: JSON.stringify({ worktreeSparseExclude: [".repos/"] }) }
            : {}),
        });
        yield* commitFiles(superproject, { "README.md": "# super\n" });
        // Git refuses file: submodule transports unless the command line allows them.
        yield* git(superproject, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "-q",
          inner,
          "sub",
        ]);
        yield* git(superproject, ["commit", "-q", "-m", "add submodule"]);
        // The checkout's git dir is .git/modules/sub, whose shared config sets
        // core.worktree = ../../../sub. An earlier sparse worktree turns on
        // extensions.worktreeConfig, and a later `git submodule update` in the superproject
        // writes core.worktree back into the shared config, so every linked worktree without
        // its own value inherits the original checkout's root.
        const checkout = path.join(superproject, "sub");
        const gitDir = path.join(superproject, ".git", "modules", "sub");
        yield* git(checkout, ["config", "extensions.worktreeConfig", "true"]);
        const readConfig = () =>
          Effect.all([
            fileSystem.readFileString(path.join(gitDir, "config")),
            fileSystem.readFileString(path.join(gitDir, "config.worktree")).pipe(Effect.option),
          ]);
        const configBefore = yield* readConfig();
        assert.equal(
          yield* git(checkout, ["config", "--file", path.join(gitDir, "config"), "core.worktree"]),
          "../../../sub",
        );
        const worktreePath = path.join(root, "worktree");

        yield* driver.createWorktree({
          cwd: checkout,
          path: worktreePath,
          refName: yield* git(checkout, ["rev-parse", "HEAD"]),
          newRefName: `feature/${mode}`,
        });

        assert.equal(yield* git(worktreePath, ["rev-parse", "--show-toplevel"]), worktreePath);
        assert.isTrue(yield* fileSystem.exists(path.join(worktreePath, "src/app.ts")));
        assert.equal(yield* fileSystem.exists(path.join(worktreePath, ".repos")), mode === "full");
        assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), `feature/${mode}`);
        // Nothing was checked out into the git dir, and the original checkout is as it was.
        assert.isFalse(yield* fileSystem.exists(path.join(gitDir, "src")));
        assert.deepStrictEqual(yield* readConfig(), configBefore);
        assert.isTrue(Option.isNone(configBefore[1]));
        assert.equal(yield* git(checkout, ["rev-parse", "--show-toplevel"]), checkout);
        assert.equal(yield* git(checkout, ["status", "--porcelain"]), "");
      }),
  );
});
