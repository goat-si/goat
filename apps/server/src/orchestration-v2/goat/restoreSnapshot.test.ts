// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { applySnapshotToWorktree, verifyRestoredWorktree } from "./restoreSnapshot.ts";

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
