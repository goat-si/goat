import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-git-vcs-contract-",
});
const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

it.effect("filterIgnoredPaths treats leading-colon paths literally and preserves ./ prefixes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-filter-ignored-pathspec-",
    });
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    yield* runGit(cwd, ["init"]);
    yield* fileSystem.writeFileString(
      path.join(cwd, ".gitignore"),
      ":ignored\nshadow\nplain.log\n",
    );

    const kept = yield* driver.filterIgnoredPaths(cwd, [
      ":ignored",
      ":shadow",
      ":(foo)",
      "keep.ts",
      "plain.log",
      "./plain.log",
    ]);
    assert.deepEqual(kept, [":shadow", ":(foo)", "keep.ts"]);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
