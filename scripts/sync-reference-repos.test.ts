import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  applyReferenceRepoSync,
  planReferenceRepoSync,
  resolveReferenceRepoRef,
} from "./sync-reference-repos.ts";

const effectSmol = referenceRepos[0]!;
const alchemyEffect = referenceRepos[1]!;

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect(
    "clones reference files without importing tags and preserves them on clone failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "reference-sync-test-" });
        const source = path.join(root, "source");
        const workspace = path.join(root, "workspace");
        yield* fs.makeDirectory(source);
        yield* fs.makeDirectory(path.join(workspace, ".repos", "fixture"), { recursive: true });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = Effect.fn("test.git")(function* (cwd: string, ...args: string[]) {
          const child = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }));
          const [stdout, exit] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.exitCode,
              Stream.runDrain(child.stderr),
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(Number(exit), 0);
          return stdout.trim();
        }, Effect.scoped);
        for (const dir of [source, workspace]) {
          yield* git(dir, "init", "-q");
          yield* git(dir, "config", "user.email", "fixture@example.invalid");
          yield* git(dir, "config", "user.name", "Fixture");
        }
        yield* fs.writeFileString(path.join(source, "reference.txt"), "new");
        yield* git(source, "add", ".");
        yield* git(source, "commit", "-qm", "reference");
        yield* git(source, "tag", "fixture-tag");
        yield* fs.writeFileString(
          path.join(workspace, ".repos", "fixture", "reference.txt"),
          "old",
        );
        yield* git(workspace, "add", ".");
        yield* git(workspace, "commit", "-qm", "initial");
        const repo = {
          ...effectSmol,
          id: "fixture",
          prefix: ".repos/fixture",
          repository: `file://${source}`,
        };
        const plan = {
          repo,
          ref: "fixture-tag",
          cloneArgs: [
            "clone",
            "--quiet",
            "--depth=1",
            "--no-tags",
            "--single-branch",
            "--branch=fixture-tag",
            repo.repository,
          ],
        };
        yield* applyReferenceRepoSync(workspace, plan).pipe(Effect.scoped);
        assert.equal(
          yield* fs.readFileString(path.join(workspace, repo.prefix, "reference.txt")),
          "new",
        );
        assert.equal(yield* git(workspace, "tag", "--list"), "");
        assert.equal(yield* git(workspace, "status", "--porcelain"), "");
        const failure = yield* Effect.result(
          applyReferenceRepoSync(workspace, {
            ...plan,
            cloneArgs: [...plan.cloneArgs.slice(0, -2), "--branch=missing", repo.repository],
          }).pipe(Effect.scoped),
        );
        assert.equal(failure._tag, "Failure");
        assert.equal(
          yield* fs.readFileString(path.join(workspace, repo.prefix, "reference.txt")),
          "new",
        );
      }).pipe(Effect.scoped),
  );
  it.effect("resolves reference tags from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  alchemy: 2.0.0-beta.84\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
      assert.equal(yield* resolveReferenceRepoRef(alchemyEffect, rootDir, false), "v2.0.0-beta.84");
    }),
  );

  it.effect("plans a shallow, tagless clone of the resolved ref", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const plan = yield* planReferenceRepoSync(effectSmol, rootDir, false);
      assert.equal(plan.ref, "effect@4.0.0-beta.73");
      assert.deepStrictEqual(plan.cloneArgs, [
        "clone",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--single-branch",
        "--branch=effect@4.0.0-beta.73",
        "https://github.com/Effect-TS/effect.git",
      ]);
    }),
  );
});
