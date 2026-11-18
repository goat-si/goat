// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import { makeRecreateMissingWorktree } from "./RecreateWorktree.ts";

it.effect("restores a deleted branch from its snapshot and refuses a moved branch", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-recreate-test-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    const worktreePath = NodePath.join(root, "worktree");
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
    NodeFS.writeFileSync(NodePath.join(repo, "tracked"), "base");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    const headSha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["worktree", "add", "-b", "feature", worktreePath]);
    NodeFS.writeFileSync(NodePath.join(worktreePath, "tracked"), "changed");
    NodeFS.writeFileSync(NodePath.join(worktreePath, "untracked"), "new");
    const indexTree = git(worktreePath, ["write-tree"]);
    const indexCommit = git(worktreePath, ["commit-tree", indexTree, "-p", headSha, "-m", "index"]);
    const index = NodePath.join(root, "index");
    NodeFS.copyFileSync(
      git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
      index,
    );
    git(worktreePath, ["add", "-A"], index);
    const tree = git(worktreePath, ["write-tree"], index);
    const snapshotSha = git(worktreePath, [
      "commit-tree",
      tree,
      "-p",
      headSha,
      "-p",
      indexCommit,
      "-m",
      "snapshot",
    ]);
    git(repo, ["update-ref", "refs/goat/snapshots/test/one", snapshotSha]);
    git(repo, ["worktree", "remove", "--force", worktreePath]);
    git(repo, ["branch", "-D", "feature"]);
    const recreate = yield* makeRecreateMissingWorktree;
    const input = {
      cwd: repo,
      worktreePath,
      branch: "feature",
      snapshot: { snapshotSha, headSha },
    };
    const result = yield* recreate(input);
    assert.equal(result.restoredFrom, "snapshot");
    assert.equal(git(worktreePath, ["rev-parse", "HEAD"]), headSha);
    assert.equal(NodeFS.readFileSync(NodePath.join(worktreePath, "tracked"), "utf8"), "changed");
    assert.equal(NodeFS.readFileSync(NodePath.join(worktreePath, "untracked"), "utf8"), "new");
    git(repo, ["worktree", "remove", "--force", worktreePath]);
    git(repo, ["commit", "--allow-empty", "-m", "moved"]);
    git(repo, ["branch", "-f", "feature", "HEAD"]);
    const error = yield* Effect.flip(recreate(input));
    assert.equal(error._tag, "WorktreeSnapshotConflictError");
    assert.isFalse(NodeFS.existsSync(worktreePath));
    assert.notInclude(git(repo, ["worktree", "list", "--porcelain"]), worktreePath);
    git(repo, ["branch", "-f", "feature", headSha]);
    const malformed = git(repo, ["commit-tree", tree, "-p", headSha, "-m", "malformed"]);
    yield* Effect.flip(recreate({ ...input, snapshot: { snapshotSha: malformed, headSha } }));
    assert.isFalse(NodeFS.existsSync(worktreePath));
    assert.notInclude(git(repo, ["worktree", "list", "--porcelain"]), worktreePath);

    const local = yield* recreate({ cwd: repo, worktreePath, branch: "feature" });
    assert.equal(local.restoredFrom, "branch");
    git(repo, ["worktree", "remove", "--force", worktreePath]);
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["remote", "add", "origin", repo]);
    git(repo, ["update-ref", "refs/remotes/origin/feature", headSha]);
    const remote = yield* recreate({ cwd: repo, worktreePath, branch: "feature" });
    assert.equal(remote.restoredFrom, "remote-branch");
    assert.equal(remote.headSha, headSha);
    git(repo, ["worktree", "remove", "--force", worktreePath]);
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["remote", "rename", "origin", "upstream"]);
    const nonOrigin = yield* recreate({ cwd: repo, worktreePath, branch: "feature" });
    assert.equal(nonOrigin.restoredFrom, "remote-branch");
    assert.equal(nonOrigin.headSha, headSha);
    git(repo, ["worktree", "remove", "--force", worktreePath]);
    git(repo, ["branch", "-D", "feature"]);
    git(repo, ["remote", "rename", "upstream", "origin"]);
    git(repo, ["update-ref", "-d", "refs/remotes/origin/feature"]);
    const base = yield* recreate({ cwd: repo, worktreePath, branch: "feature" });
    assert.equal(base.restoredFrom, "base");
    assert.equal(base.headSha, git(repo, ["rev-parse", "main"]));
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
