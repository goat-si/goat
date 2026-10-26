// @effect-diagnostics nodeBuiltinImport:off - builds a scratch repository with a linked worktree to stand in for the developer's checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { makeCheckpointWorkspace } from "./replayWorkspace.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("makeCheckpointWorkspace", () => {
  // Git hooks, `git rebase --exec` and `git bisect run` export GIT_DIR for the worktree that
  // started them. A test run launched from one must not write into that worktree's shared
  // repository (#1114).
  it("keeps the shared config and branch of an inherited GIT_DIR worktree unchanged", async () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-inherited-git-dir-")),
    );
    try {
      const main = NodePath.join(root, "main");
      git(root, "init", "--quiet", "--initial-branch=main", main);
      git(
        main,
        "-c",
        "user.name=Owner",
        "-c",
        "user.email=owner@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "init",
      );
      git(main, "worktree", "add", "--quiet", "-b", "lane", NodePath.join(root, "lane"));
      const sharedConfigPath = NodePath.join(main, ".git", "config");
      const sharedConfig = NodeFS.readFileSync(sharedConfigPath, "utf8");
      const laneHead = git(main, "rev-parse", "lane");

      vi.stubEnv("GIT_DIR", NodePath.join(main, ".git", "worktrees", "lane"));
      let workspace: string;
      try {
        workspace = await makeCheckpointWorkspace("inherited-git-dir");
      } finally {
        vi.unstubAllEnvs();
      }
      try {
        expect(NodeFS.readFileSync(sharedConfigPath, "utf8")).toBe(sharedConfig);
        expect(git(main, "rev-parse", "lane")).toBe(laneHead);
        expect(git(workspace, "log", "--format=%an %s")).toBe("GOAT Test initial");
      } finally {
        NodeFS.rmSync(workspace, { recursive: true, force: true });
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
