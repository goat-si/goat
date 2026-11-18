// @effect-diagnostics nodeBuiltinImport:off - pathToFileURL builds the file: submodule URL.
import * as NodeURL from "node:url";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-submodule-progress-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

// Git refuses file: submodule transports (CVE-2022-39253) despite repo config, and GOAT's git
// runs inherit the process environment, so the fixture allows it there for this case.
const allowFileProtocol = Effect.acquireRelease(
  Effect.sync(() => {
    const previous = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file";
    return previous;
  }),
  (previous) =>
    Effect.sync(() => {
      if (previous === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
      else process.env.GIT_ALLOW_PROTOCOL = previous;
    }),
);

it.layer(layerTest)("worktree submodule progress", (it) => {
  it.effect("a new worktree reports a submodule's transfer progress to its line callback", () =>
    Effect.gen(function* () {
      yield* allowFileProtocol;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({
          operation: "GitVcsDriver.test.git",
          cwd,
          args: ["-c", "user.email=test@test.com", "-c", "user.name=Test", ...args],
        });
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "git-submodule-progress-" });
      const shared = path.join(root, "shared");
      const repo = path.join(root, "repo");
      for (const dir of [shared, repo]) {
        yield* fileSystem.makeDirectory(dir, { recursive: true });
        yield* git(dir, ["init", "-q", "--initial-branch=main"]);
        yield* fileSystem.writeFileString(path.join(dir, "README.md"), "# readme\n");
        yield* git(dir, ["add", "."]);
        yield* git(dir, ["commit", "-q", "-m", "init"]);
      }
      // A file URL transfers a pack like a network remote; a plain path hardlinks silently.
      yield* git(repo, ["submodule", "add", NodeURL.pathToFileURL(shared).href, "shared"]);
      yield* git(repo, ["commit", "-q", "-m", "add submodule"]);

      const lines: Array<string> = [];
      const created = yield* driver.createWorktree(
        {
          cwd: repo,
          refName: "main",
          newRefName: "feature/progress",
          path: path.join(root, "worktrees", "progress"),
        },
        {
          submodules: "recursive",
          progress: { onSubmoduleLine: (line) => Effect.sync(() => void lines.push(line)) },
        },
      );

      assert.isTrue(
        yield* fileSystem.exists(path.join(created.worktree.path, "shared", "README.md")),
      );
      assert.isTrue(lines.some((line) => line.startsWith("Receiving objects")));
    }).pipe(Effect.scoped),
  );
});
