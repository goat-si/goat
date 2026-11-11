// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { hostCanStoreFileName } from "@goat/shared/testing/fileNames";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerGit = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-materialize-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  }).trim();

const fixture = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-materialize-"));
    const source = NodePath.join(root, "source");
    NodeFS.mkdirSync(source);
    git(source, ["init", "-q", "-b", "main"]);
    git(source, ["config", "user.name", "Test"]);
    git(source, ["config", "user.email", "test@example.com"]);
    return { root, source, dest: NodePath.join(root, "dest") };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

const write = (dir: string, name: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, name)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, name), content);
};
const read = (dir: string, name: string) => NodeFS.readFileSync(NodePath.join(dir, name), "utf8");

/** Commits files, applies changes, captures the snapshot and checks out a worktree at its base. */
const prepare = Effect.fnUntraced(function* (
  files: Readonly<Record<string, string>>,
  change: (source: string) => void,
  addWorktree: (fx: {
    readonly source: string;
    readonly dest: string;
    readonly base: string;
  }) => void = (fx) => git(fx.source, ["worktree", "add", "--detach", fx.dest, fx.base]),
) {
  const { root, source, dest } = yield* fixture;
  for (const [name, content] of Object.entries(files)) write(source, name, content);
  git(source, ["add", "."]);
  git(source, ["commit", "-q", "-m", "base"]);
  change(source);
  const driver = yield* GitVcsDriver.makeVcsDriverShape();
  const snapshot = yield* driver.captureWorkspaceSnapshot({
    cwd: source,
    snapshotRef: "refs/goat/snapshots/materialize-test",
  });
  const base = git(source, ["rev-parse", `${snapshot.commitOid}^`]);
  addWorktree({ source, dest, base });
  return { driver, root, source, dest, base, snapshotCommit: snapshot.commitOid };
});

it.effect("writes edits, deletions and new files into the base checkout without staging them", () =>
  Effect.gen(function* () {
    const fx = yield* prepare(
      { "tracked.txt": "base\n", "deleted.txt": "doomed\n", "same.txt": "same\n" },
      (source) => {
        write(source, "tracked.txt", "edited\n");
        NodeFS.rmSync(NodePath.join(source, "deleted.txt"));
        write(source, "staged.txt", "staged\n");
        git(source, ["add", "staged.txt"]);
        write(source, "nested/untracked.txt", "new\n");
      },
    );
    const sameMtime = NodeFS.statSync(NodePath.join(fx.dest, "same.txt")).mtimeMs;

    const result = yield* fx.driver.materializeWorkspaceSnapshot({
      cwd: fx.dest,
      baseCommit: fx.base,
      snapshotCommit: fx.snapshotCommit,
    });

    assert.equal(result.changedPaths, 4);
    assert.equal(read(fx.dest, "tracked.txt"), "edited\n");
    assert.isFalse(NodeFS.existsSync(NodePath.join(fx.dest, "deleted.txt")));
    assert.equal(read(fx.dest, "staged.txt"), "staged\n");
    assert.equal(read(fx.dest, "nested/untracked.txt"), "new\n");
    assert.equal(NodeFS.statSync(NodePath.join(fx.dest, "same.txt")).mtimeMs, sameMtime);
    assert.equal(git(fx.dest, ["rev-parse", "HEAD"]), fx.base);
    assert.equal(git(fx.dest, ["diff", "--cached", "--name-only"]), "");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("sets the executable bit the snapshot records", () =>
  Effect.gen(function* () {
    const fx = yield* prepare({ "script.sh": "echo hi\n" }, () => {});
    // The server test setup forces core.filemode=false, so the snapshot is built by hand.
    const index = NodePath.join(fx.root, "mode-index");
    const env = { GIT_INDEX_FILE: index };
    git(fx.source, ["read-tree", fx.base], env);
    git(fx.source, ["update-index", "--chmod=+x", "script.sh"], env);
    const tree = git(fx.source, ["write-tree"], env);
    const snapshotCommit = git(fx.source, ["commit-tree", tree, "-p", fx.base, "-m", "mode"]);

    yield* fx.driver.materializeWorkspaceSnapshot({
      cwd: fx.dest,
      baseCommit: fx.base,
      snapshotCommit,
    });

    assert.notEqual(NodeFS.statSync(NodePath.join(fx.dest, "script.sh")).mode & 0o111, 0);
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("a file named like pathspec magic selects only itself", () =>
  Effect.gen(function* () {
    const magic = ":(literal)target.txt";
    if (!hostCanStoreFileName(magic)) return;
    const fx = yield* prepare({ [magic]: "magic base\n", "target.txt": "plain base\n" }, (source) =>
      write(source, magic, "magic edit\n"),
    );

    yield* fx.driver.materializeWorkspaceSnapshot({
      cwd: fx.dest,
      baseCommit: fx.base,
      snapshotCommit: fx.snapshotCommit,
    });

    assert.equal(read(fx.dest, magic), "magic edit\n");
    assert.equal(read(fx.dest, "target.txt"), "plain base\n");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("writes a changed file under a sparse exclusion and leaves its siblings out", () =>
  Effect.gen(function* () {
    const fx = yield* prepare(
      {
        "excluded/inside.txt": "inside base\n",
        "excluded/sibling.txt": "sibling\n",
        "kept.txt": "kept\n",
      },
      (source) => write(source, "excluded/inside.txt", "inside edit\n"),
      ({ source, dest, base }) => {
        git(source, ["worktree", "add", "--no-checkout", "--detach", dest, base]);
        git(dest, ["sparse-checkout", "set", "--no-cone", "/*", "!/excluded/"]);
        git(dest, ["checkout", "-q", "--detach", base]);
      },
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(fx.dest, "excluded/inside.txt")));

    yield* fx.driver.materializeWorkspaceSnapshot({
      cwd: fx.dest,
      baseCommit: fx.base,
      snapshotCommit: fx.snapshotCommit,
    });

    assert.equal(read(fx.dest, "excluded/inside.txt"), "inside edit\n");
    assert.isFalse(NodeFS.existsSync(NodePath.join(fx.dest, "excluded/sibling.txt")));
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);

it.effect("fails when a written file does not match the snapshot", () =>
  Effect.gen(function* () {
    const fx = yield* prepare(
      { ".gitattributes": "*.txt filter=shout\n", "note.txt": "quiet\n" },
      (source) => write(source, "note.txt", "still quiet\n"),
    );
    // A checkout filter that rewrites content makes the written file differ from the snapshot's blob.
    git(fx.dest, ["config", "filter.shout.smudge", "tr a-z A-Z"]);
    git(fx.dest, ["config", "filter.shout.clean", "cat"]);

    const error = yield* fx.driver
      .materializeWorkspaceSnapshot({
        cwd: fx.dest,
        baseCommit: fx.base,
        snapshotCommit: fx.snapshotCommit,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "verify_failed");
  }).pipe(Effect.scoped, Effect.provide(layerGit)),
);
