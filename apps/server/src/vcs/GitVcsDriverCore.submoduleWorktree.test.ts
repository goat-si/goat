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

const git = Effect.fn("test.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "GitVcsDriver.test.git",
    cwd,
    // Git refuses file: submodule transports unless the command line allows them.
    args: [
      "-c",
      "user.email=test@test.com",
      "-c",
      "user.name=Test",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    timeoutMs: 10_000,
  });
  return result.stdout.trim();
});

const commitFiles = Effect.fn("test.commitFiles")(function* (
  cwd: string,
  files: Record<string, string>,
) {
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

/**
 * A checkout that is itself a submodule, as GOAT is inside a superproject: its git dir is
 * `<superproject>/.git/modules/sub`, whose shared config sets `core.worktree = ../../../sub`.
 */
const makeSubmoduleCheckout = Effect.fn("test.makeSubmoduleCheckout")(function* (sparse: boolean) {
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
    ...(sparse
      ? { [GOAT_PROJECT_FILE_NAME]: JSON.stringify({ worktreeSparseExclude: [".repos/"] }) }
      : {}),
  });
  yield* commitFiles(superproject, { "README.md": "# super\n" });
  yield* git(superproject, ["submodule", "add", "-q", inner, "sub"]);
  yield* git(superproject, ["commit", "-q", "-m", "add submodule"]);
  const checkout = path.join(superproject, "sub");
  const gitDir = path.join(superproject, ".git", "modules", "sub");
  const head = yield* git(checkout, ["rev-parse", "HEAD"]);
  // A setup hook would install dependencies into whatever root it sees. Like this
  // repository's, the hooks directory is relative, generated and untracked.
  const hookLog = path.join(root, "post-checkout-roots");
  const hook = path.join(checkout, ".hooks", "post-checkout");
  yield* git(checkout, ["config", "core.hooksPath", ".hooks"]);
  yield* fileSystem.writeFileString(path.join(gitDir, "info", "exclude"), ".hooks/\n");
  yield* fileSystem.makeDirectory(path.dirname(hook), { recursive: true });
  yield* fileSystem.writeFileString(
    hook,
    "#!/bin/sh\ngit rev-parse --show-toplevel >> '" + hookLog + "'\n",
  );
  yield* fileSystem.chmod(hook, 0o755);
  const hookRoots = () =>
    fileSystem.readFileString(hookLog).pipe(
      Effect.map((contents) => contents.trim().split("\n")),
      Effect.orElseSucceed(() => []),
    );
  const createWorktree = Effect.fn("test.createWorktree")(function* (
    name: string,
    { relative = false, from = checkout }: { relative?: boolean; from?: string } = {},
  ) {
    const worktreePath = path.join(root, name);
    const { worktree } = yield* driver.createWorktree({
      cwd: from,
      // Git resolves a relative destination against the checkout.
      path: relative ? path.relative(from, worktreePath) : worktreePath,
      refName: head,
      newRefName: `feature/${name}`,
    });
    assert.equal(worktree.path, worktreePath);
    return worktreePath;
  });
  /** What `git submodule update` in the superproject rewrites, among other things. */
  const updateSubmodule = () => git(superproject, ["submodule", "update", "--init"]);
  const readConfig = () =>
    Effect.all([
      fileSystem.readFileString(path.join(gitDir, "config")),
      fileSystem.readFileString(path.join(gitDir, "config.worktree")).pipe(Effect.option),
    ]);
  const sharedRoot = () =>
    git(checkout, ["config", "--file", path.join(gitDir, "config"), "core.worktree"]);
  return {
    root,
    checkout,
    gitDir,
    createWorktree,
    updateSubmodule,
    readConfig,
    sharedRoot,
    hookRoots,
  };
});

const assertCheckedOutInPlace = Effect.fn("test.assertCheckedOutInPlace")(function* (
  worktreePath: string,
  input: { readonly gitDir: string; readonly sparse: boolean },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  assert.equal(yield* git(worktreePath, ["rev-parse", "--show-toplevel"]), worktreePath);
  assert.isTrue(yield* fileSystem.exists(path.join(worktreePath, "src/app.ts")));
  assert.equal(yield* fileSystem.exists(path.join(worktreePath, ".repos")), !input.sparse);
  assert.equal(yield* git(worktreePath, ["status", "--porcelain"]), "");
  // Nothing was checked out into the git dir.
  assert.isFalse(yield* fileSystem.exists(path.join(input.gitDir, "src")));
});

it.layer(layerTest)("worktrees of a submodule checkout", (it) => {
  it.effect.each(["sparse", "full"] as const)(
    "a %s worktree checks out into its own directory and leaves the submodule's config alone (#799)",
    (mode) =>
      Effect.gen(function* () {
        const repo = yield* makeSubmoduleCheckout(mode === "sparse");
        // An earlier sparse worktree turned extensions.worktreeConfig on, and a later
        // `git submodule update` wrote core.worktree back into the shared config.
        yield* git(repo.checkout, ["config", "extensions.worktreeConfig", "true"]);
        assert.equal(yield* repo.sharedRoot(), "../../../sub");
        const configBefore = yield* repo.readConfig();
        assert.isTrue(Option.isNone(configBefore[1]));

        const worktreePath = yield* repo.createWorktree(mode, { relative: mode === "full" });

        yield* assertCheckedOutInPlace(worktreePath, {
          gitDir: repo.gitDir,
          sparse: mode === "sparse",
        });
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), `feature/${mode}`);
        assert.deepStrictEqual(yield* repo.hookRoots(), [worktreePath]);
        assert.deepStrictEqual(yield* repo.readConfig(), configBefore);
        assert.equal(yield* git(repo.checkout, ["rev-parse", "--show-toplevel"]), repo.checkout);
        assert.equal(yield* git(repo.checkout, ["status", "--porcelain"]), "");
      }),
  );

  it.effect(
    "a sparse worktree keeps its own root after git submodule update rewrites the shared one (#799)",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeSubmoduleCheckout(true);
        const first = yield* repo.createWorktree("first");
        yield* repo.updateSubmodule();
        assert.equal(yield* repo.sharedRoot(), "../../../sub");

        const second = yield* repo.createWorktree("second");

        yield* assertCheckedOutInPlace(first, { gitDir: repo.gitDir, sparse: true });
        yield* assertCheckedOutInPlace(second, { gitDir: repo.gitDir, sparse: true });
        assert.deepStrictEqual(yield* repo.hookRoots(), [first, second]);
        assert.equal(yield* git(repo.checkout, ["rev-parse", "--show-toplevel"]), repo.checkout);
        assert.equal(yield* git(repo.checkout, ["status", "--porcelain"]), "");
      }),
  );

  it.effect(
    "a worktree made from a linked checkout keeps its own root after git submodule update (#799)",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const repo = yield* makeSubmoduleCheckout(true);
        // A linked checkout made outside GOAT. Its sparse checkout moved core.worktree into
        // the main worktree's config.worktree, which the linked checkout does not read.
        const linked = path.join(repo.root, "linked");
        yield* git(repo.checkout, [
          "worktree",
          "add",
          "-q",
          "--no-checkout",
          "-b",
          "linked",
          linked,
        ]);
        yield* git(linked, ["sparse-checkout", "set", "--no-cone", "/*", "!/.repos/"]);
        yield* git(linked, ["checkout", "-q", "-f"]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const inherited = yield* driver.execute({
          operation: "GitVcsDriver.test.git",
          cwd: linked,
          args: ["config", "--get-all", "core.worktree"],
          allowNonZeroExit: true,
        });
        assert.equal(inherited.stdout, "");

        const child = yield* repo.createWorktree("child", { from: linked });
        yield* repo.updateSubmodule();

        yield* assertCheckedOutInPlace(child, { gitDir: repo.gitDir, sparse: true });
      }),
  );
});
