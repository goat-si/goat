// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { applySnapshotToWorktree, git, verifyRestoredWorktree } from "./restoreSnapshot.ts";

it.effect("restores worktree and index trees including file type changes", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-restore-test-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    const worktree = NodePath.join(root, "worktree");
    NodeFS.mkdirSync(repo);
    const git = (cwd: string, args: string[], index?: string) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
        encoding: "utf8",
      }).trim();
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    for (const name of ["edit", "delete", "mode", "file-to-dir", "staged"])
      NodeFS.writeFileSync(NodePath.join(repo, name), name);
    NodeFS.mkdirSync(NodePath.join(repo, "dir-to-file"));
    NodeFS.writeFileSync(NodePath.join(repo, "dir-to-file", "child"), "child");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["worktree", "add", "-b", "feature", worktree]);
    NodeFS.writeFileSync(NodePath.join(worktree, "staged"), "staged change");
    NodeFS.writeFileSync(NodePath.join(worktree, "staged-deleted"), "staged addition");
    git(worktree, ["add", "staged", "staged-deleted"]);
    NodeFS.rmSync(NodePath.join(worktree, "staged-deleted"));
    const indexTree = git(worktree, ["write-tree"]);
    const indexCommit = git(worktree, ["commit-tree", indexTree, "-p", head, "-m", "index"]);
    NodeFS.writeFileSync(NodePath.join(worktree, "edit"), "modified");
    NodeFS.rmSync(NodePath.join(worktree, "delete"));
    NodeFS.chmodSync(NodePath.join(worktree, "mode"), 0o755);
    NodeFS.writeFileSync(NodePath.join(worktree, "binary"), Buffer.from([0, 255, 1]));
    NodeFS.symlinkSync("edit", NodePath.join(worktree, "link"));
    NodeFS.rmSync(NodePath.join(worktree, "file-to-dir"));
    NodeFS.mkdirSync(NodePath.join(worktree, "file-to-dir"));
    NodeFS.writeFileSync(NodePath.join(worktree, "file-to-dir", "child"), "new");
    NodeFS.rmSync(NodePath.join(worktree, "dir-to-file"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, "dir-to-file"), "new file");
    const temporaryIndex = NodePath.join(root, "index");
    NodeFS.copyFileSync(
      git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
      temporaryIndex,
    );
    git(worktree, ["add", "-A"], temporaryIndex);
    const tree = git(worktree, ["write-tree"], temporaryIndex);
    const snapshot = git(worktree, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-p",
      indexCommit,
      "-m",
      "snapshot",
    ]);
    git(repo, ["worktree", "remove", "--force", worktree]);
    git(repo, ["worktree", "add", worktree, "feature"]);
    yield* applySnapshotToWorktree({ cwd: worktree, snapshotSha: snapshot });
    yield* verifyRestoredWorktree({
      cwd: worktree,
      branch: "feature",
      expectedHead: head,
      snapshot,
    });
    assert.deepEqual(
      NodeFS.readFileSync(NodePath.join(worktree, "binary")),
      Buffer.from([0, 255, 1]),
    );
    const wrongHead = yield* Effect.flip(
      verifyRestoredWorktree({ cwd: worktree, branch: "feature", expectedHead: snapshot }),
    );
    assert.equal(wrongHead.detail, "head");
    NodeFS.writeFileSync(NodePath.join(worktree, "edit"), "wrong");
    const wrongTree = yield* Effect.flip(
      verifyRestoredWorktree({ cwd: worktree, branch: "feature", expectedHead: head, snapshot }),
    );
    assert.equal(wrongTree.detail, "worktree-tree");
  }).pipe(Effect.scoped),
);

it.effect("restores deleted dot-prefixed paths and removes their empty parents", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-restore-test-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    const worktree = NodePath.join(root, "worktree");
    NodeFS.mkdirSync(repo);
    const git = (cwd: string, args: string[], index?: string) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd,
        env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
        encoding: "utf8",
      }).trim();
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    const deleted = [
      "..foo",
      NodePath.join("dir", "..bar", "child"),
      NodePath.join("..bar", "child"),
    ];
    for (const name of deleted) {
      const path = NodePath.join(repo, name);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, name);
    }
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["worktree", "add", "-b", "feature", worktree]);
    for (const name of deleted) NodeFS.rmSync(NodePath.join(worktree, name));
    const temporaryIndex = NodePath.join(root, "index");
    NodeFS.copyFileSync(
      git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
      temporaryIndex,
    );
    git(worktree, ["add", "-A"], temporaryIndex);
    const tree = git(worktree, ["write-tree"], temporaryIndex);
    const indexCommit = git(worktree, [
      "commit-tree",
      git(worktree, ["rev-parse", `${head}^{tree}`]),
      "-p",
      head,
      "-m",
      "index",
    ]);
    const snapshot = git(worktree, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-p",
      indexCommit,
      "-m",
      "snapshot",
    ]);
    git(repo, ["worktree", "remove", "--force", worktree]);
    git(repo, ["worktree", "add", worktree, "feature"]);
    yield* applySnapshotToWorktree({ cwd: worktree, snapshotSha: snapshot });
    yield* verifyRestoredWorktree({
      cwd: worktree,
      branch: "feature",
      expectedHead: head,
      snapshot,
    });
    for (const name of deleted) assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, name)));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "..bar")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(worktree, "dir", "..bar")));
  }).pipe(Effect.scoped),
);

it.effect("rejects parent traversal without deleting the outside file", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-restore-test-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    const outside = NodePath.join(root, "outside");
    NodeFS.mkdirSync(repo);
    NodeFS.writeFileSync(outside, "keep");
    const git = (args: string[], input?: string | Buffer) =>
      NodeChildProcess.execFileSync("git", args, {
        cwd: repo,
        input,
        encoding: "utf8",
      }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    const blob = git(["hash-object", "-w", "--stdin"], "delete");
    const maliciousTree = git(
      ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"],
      Buffer.concat([Buffer.from("100644 ../outside\0"), Buffer.from(blob, "hex")]),
    );
    const emptyTree = git(
      ["hash-object", "-t", "tree", "-w", "--stdin", "--literally"],
      Buffer.alloc(0),
    );
    const head = git(["commit-tree", maliciousTree, "-m", "base"]);
    git(["update-ref", "HEAD", head]);
    const indexCommit = git(["commit-tree", maliciousTree, "-p", head, "-m", "index"]);
    const snapshot = git([
      "commit-tree",
      emptyTree,
      "-p",
      head,
      "-p",
      indexCommit,
      "-m",
      "snapshot",
    ]);
    const error = yield* Effect.flip(applySnapshotToWorktree({ cwd: repo, snapshotSha: snapshot }));
    assert.equal(error.detail, "apply");
    assert.include(String(error.cause), "Invalid snapshot path");
    assert.equal(NodeFS.readFileSync(outside, "utf8"), "keep");
  }).pipe(Effect.scoped),
);

it.live("a Git deadline settles even while a process Git started keeps its output open", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-restore-test-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    // The backgrounded sleep inherits stderr, as a hung checkout filter's helper would.
    const error = yield* Effect.flip(
      Effect.tryPromise(() =>
        git(root, ["-c", "alias.hang=!sleep 600 & sleep 600", "hang"], { timeoutMs: 200 }),
      ),
    );
    assert.include(String(error.cause), "timed out");
  }).pipe(Effect.scoped),
);
