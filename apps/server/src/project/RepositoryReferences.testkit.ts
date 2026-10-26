import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "@effect/vitest";
import { ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as Projects from "./ProjectService.ts";
import * as Inventory from "./RepositoryInventory.ts";
import * as References from "./RepositoryReferences.ts";

export const referenceTestLayer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

export const referenceFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "goat-reference-" }));
  const repo = root + "/source ; no-shell";
  yield* fs.makeDirectory(repo);
  const git = (args: ReadonlyArray<string>, cwd = repo) =>
    runner.run({ command: "git", args: ["-C", cwd, ...args] }).pipe(
      Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))),
      Effect.map((result) => result.stdout.trim()),
    );
  yield* git(["init", "-b", "main"]);
  yield* git(["config", "user.name", "Reference fixture"]);
  yield* git(["config", "user.email", "reference@example.test"]);
  yield* git([
    "remote",
    "add",
    "origin",
    "https://fixture-user:fixture-password@invalid.example/acme/sibling.git",
  ]);
  yield* fs.writeFileString(repo + "/source.ts", "export const result = 42;\n");
  yield* git(["add", "source.ts"]);
  yield* git(["commit", "-m", "base"]);
  const base = yield* git(["rev-parse", "HEAD"]);
  yield* git(["update-ref", "refs/remotes/origin/main", base]);
  yield* git(["branch", "--set-upstream-to=origin/main"]);
  const source = {
    mode: "snapshot" as const,
    repositoryKey: "invalid.example/acme/sibling",
    files: ["source.ts"],
  };
  let registered = true;
  let beforeRun: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<void, ProcessRunner.ProcessRunError> = () => Effect.void;
  const commands: Array<ProcessRunner.ProcessRunInput> = [];
  const layer = References.layer.pipe(
    Layer.provide(Inventory.layer),
    Layer.provide(
      Layer.mock(Projects.ProjectService)({
        listShells: () =>
          Effect.succeed(
            registered
              ? [
                  {
                    id: ProjectId.make("sibling"),
                    title: "Sibling",
                    workspaceRoot: repo,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ]
              : [],
          ),
      }),
    ),
    Layer.provide(
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            commands.push(input);
          }).pipe(Effect.andThen(beforeRun(input)), Effect.andThen(runner.run(input))),
      }),
    ),
  );
  const capture = (input: unknown = source) =>
    References.RepositoryReferences.pipe(
      Effect.flatMap((service) => service.capture(input)),
      Effect.provide(layer),
    );
  const state = Effect.gen(function* () {
    return {
      bytes: yield* fs.readFile(repo + "/source.ts"),
      config: yield* fs.readFile(repo + "/.git/config"),
      index: yield* fs.readFile(repo + "/.git/index"),
      refs: yield* git(["show-ref"]),
    };
  });
  return {
    fs,
    root,
    repo,
    git,
    base,
    source,
    layer,
    capture,
    state,
    commands,
    unregister: () => {
      registered = false;
    },
    intercept: (callback: typeof beforeRun) => {
      beforeRun = callback;
    },
  };
});
