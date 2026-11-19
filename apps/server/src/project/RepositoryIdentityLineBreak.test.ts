import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const cases = HostProcess.Platform.defaultValue() === "win32" ? [] : ["\r", "\n"];
it.layer(NodeServices.layer)("repository paths with line breaks", (it) => {
  it.effect.each(
    cases.flatMap((suffix) => [
      { suffix, bare: false },
      { suffix, bare: true },
    ]),
  )("retains $suffix in bare=$bare paths", ({ suffix, bare }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "goat-repo-linebreak-" });
      const root = path.join(parent, `repo${suffix}`);
      yield* fs.makeDirectory(root);
      const runner = yield* ProcessRunner.ProcessRunner;
      const git = (args: string[]) =>
        runner.run({
          command: "git",
          args: ["-C", root, ...args],
          env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
      yield* git(bare ? ["init", "--bare"] : ["init"]);
      yield* git(["remote", "add", "origin", "git@github.com:acme/repo.git"]);
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(root);
      expect(identity?.rootPath).toBe(yield* fs.realPath(root));
    }).pipe(Effect.provide(Layer.merge(ProcessRunner.layer, RepositoryIdentityResolver.layer))),
  );
});
