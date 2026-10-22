import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Runner from "../processRunner.ts";
import * as Git from "./NotesGit.ts";

it.effect("coalesces edits into one commit at the Clock deadline", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    const calls: Array<ReadonlyArray<string>> = [];
    const runner = Layer.succeed(Runner.ProcessRunner, {
      run: (input) =>
        Effect.gen(function* () {
          calls.push(input.args);
          if (input.args.includes("commit")) yield* Deferred.succeed(committed, undefined);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(input.args.includes("--quiet") ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    yield* Effect.gen(function* () {
      const git = yield* Git.NotesGit;
      yield* git.changed;
      yield* TestClock.adjust("1 second");
      yield* git.changed;
      yield* TestClock.adjust("1999 millis");
      assert.strictEqual(calls.length, 0);
      yield* TestClock.adjust("1 milli");
      yield* Deferred.await(committed);
      assert.strictEqual(calls.filter((args) => args.includes("commit")).length, 1);
      assert.isTrue(calls.at(-1)!.includes("user.name=GOAT Notes"));
      assert.isTrue(calls.at(-1)!.includes("commit.gpgsign=false"));
    }).pipe(
      Effect.provide(
        Git.layer.pipe(
          Layer.provide(runner),
          Layer.provide(Config.layerTest("/tmp", { prefix: "notes-git-test-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);

it.effect("a missing git executable disables commits without failing notes", () => {
  let spawns = 0;
  return Effect.gen(function* () {
    const git = yield* Git.NotesGit;
    yield* git.flush;
    yield* git.flush;
    assert.strictEqual(spawns, 1);
  }).pipe(
    Effect.provide(
      Git.layer.pipe(
        Layer.provide(
          Layer.succeed(Runner.ProcessRunner, {
            run: () => {
              spawns++;
              return Effect.fail(
                new Runner.ProcessSpawnError({
                  command: "git",
                  argumentCount: 0,
                  cause: new Error("missing"),
                }),
              );
            },
          }),
        ),
        Layer.provide(Config.layerTest("/tmp", { prefix: "notes-git-test-" })),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

it.live("initializes an isolated repository and commits own and external edits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const git = yield* Git.NotesGit;
    const runner = yield* Runner.ProcessRunner;
    yield* fs.makeDirectory(notesDir, { recursive: true });
    yield* fs.writeFileString(`${notesDir}/task.md`, "task");
    yield* git.flush;
    yield* fs.writeFileString(`${notesDir}/task.md`, "updated outside GOAT");
    yield* git.flush;
    const log = yield* runner.run({
      command: "git",
      args: ["log", "--format=%an:%s"],
      cwd: notesDir,
    });
    assert.strictEqual(log.code, 0);
    assert.strictEqual(log.stdout.trim().split("\n").length, 2);
    assert.include(log.stdout, "GOAT Notes:notes: update task.md");
    const clean = yield* runner.run({
      command: "git",
      args: ["status", "--porcelain"],
      cwd: notesDir,
    });
    assert.strictEqual(clean.stdout, "");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Git.layer.pipe(
        Layer.provideMerge(Runner.layer),
        Layer.provideMerge(Config.layerTest("/tmp", { prefix: "notes-git-real-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.live("isolates repository, config, index and both identities from inherited Git overrides", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const runner = yield* Runner.ProcessRunner;
    const outside = yield* fs.makeTempDirectoryScoped({ prefix: "notes-git-outside-" });
    yield* runner.run({ command: "git", args: ["init"], cwd: outside });
    yield* fs.writeFileString(`${outside}/keep.md`, "outside");
    yield* fs.makeDirectory(notesDir, { recursive: true });
    yield* fs.writeFileString(`${notesDir}/task.md`, "---\nupdatedBy: agent\n---\ntask");
    const overrides = {
      GIT_DIR: `${outside}/.git`,
      GIT_WORK_TREE: outside,
      GIT_INDEX_FILE: `${outside}/foreign-index`,
      GIT_AUTHOR_NAME: "Inherited author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_COMMITTER_NAME: "Inherited committer",
      GIT_COMMITTER_EMAIL: "committer@example.invalid",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    yield* Effect.acquireRelease(
      Effect.sync(() => Object.assign(process.env, overrides)),
      () =>
        Effect.sync(() => {
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
    const git = yield* Git.NotesGit;
    yield* git.flush;
    const cleanEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, undefined]));
    const log = yield* runner.run({
      command: "git",
      args: ["log", "--format=%an:%ae:%cn:%ce:%s"],
      cwd: notesDir,
      env: cleanEnv,
    });
    assert.strictEqual(log.code, 0);
    assert.include(
      log.stdout,
      "GOAT Notes:notes@goat.local:GOAT Notes:notes@goat.local:notes: update task.md (agent)",
    );
    assert.isFalse(yield* fs.exists(`${outside}/foreign-index`));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Git.layer.pipe(
        Layer.provideMerge(Runner.layer),
        Layer.provideMerge(Config.layerTest("/tmp", { prefix: "notes-git-env-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.live("describes batched changes and deleted paths in commit subjects", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { notesDir } = yield* Config.ServerConfig;
    const git = yield* Git.NotesGit;
    const runner = yield* Runner.ProcessRunner;
    yield* fs.makeDirectory(notesDir, { recursive: true });
    for (const name of ["one.md", "two.md", "three.md"])
      yield* fs.writeFileString(`${notesDir}/${name}`, "task");
    yield* git.flush;
    yield* fs.remove(`${notesDir}/one.md`);
    yield* git.flush;
    const log = yield* runner.run({ command: "git", args: ["log", "--format=%s"], cwd: notesDir });
    assert.strictEqual(log.code, 0);
    assert.deepStrictEqual(log.stdout.trim().split("\n"), [
      "notes: delete one.md",
      "notes: 3 changes",
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Git.layer.pipe(
        Layer.provideMerge(Runner.layer),
        Layer.provideMerge(Config.layerTest("/tmp", { prefix: "notes-git-subject-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
