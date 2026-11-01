// @effect-diagnostics nodeBuiltinImport:off - drives real git against throwaway repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";

const SCRIPT = NodePath.join(import.meta.dirname, "worktree-add.ts");
const ZERO = "0".repeat(40);

function scratch() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worktree-add-test-")),
  );
  const globalConfig = NodePath.join(root, "gitconfig");
  NodeFS.writeFileSync(
    globalConfig,
    '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[protocol "file"]\n\tallow = always\n',
  );
  const env = { ...isolatedGitEnv(), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const hookLog = NodePath.join(root, "hook.log");
  const emptyConfig = NodePath.join(root, "empty-gitconfig");
  NodeFS.writeFileSync(emptyConfig, "");
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const repo = (name: string) => {
    const path = NodePath.join(root, name);
    git(root, "init", "--quiet", "-b", "main", path);
    NodeFS.writeFileSync(NodePath.join(path, "README.md"), "fixture\n");
    git(path, "add", "README.md");
    git(path, "commit", "--quiet", "-m", "init");
    return path;
  };
  return {
    root,
    emptyConfig,
    git,
    repo,
    /** A checkout of the fixture as a submodule, which keeps its git dir in .git/modules. */
    submodule(options: { readonly worktreeConfig: boolean }) {
      const upstream = repo("upstream");
      const superproject = repo("super");
      git(superproject, "submodule", "--quiet", "add", upstream, "goat");
      git(superproject, "commit", "--quiet", "-m", "add submodule");
      const checkout = NodePath.join(superproject, "goat");
      if (options.worktreeConfig) git(checkout, "config", "extensions.worktreeConfig", "true");
      return checkout;
    },
    /** A relative, untracked hooks dir, like the generated .vite-hooks/_. */
    installHook(checkout: string) {
      const hooks = NodePath.join(checkout, ".hooks", "_");
      NodeFS.mkdirSync(hooks, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(hooks, "post-checkout"),
        `#!/bin/sh\necho "$(git rev-parse --show-toplevel) $1" >> "${hookLog}"\n`,
        { mode: 0o755 },
      );
      git(checkout, "config", "core.hooksPath", ".hooks/_");
    },
    hookRuns: () =>
      NodeFS.existsSync(hookLog) ? NodeFS.readFileSync(hookLog, "utf8").trim().split("\n") : [],
    worktreeAdd: (cwd: string, args: ReadonlyArray<string>, extraEnv: NodeJS.ProcessEnv = {}) =>
      NodeChildProcess.spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
      }),
    /** What the original checkout must still look like afterwards. */
    snapshot(checkout: string) {
      const common = NodePath.resolve(checkout, git(checkout, "rev-parse", "--git-common-dir"));
      return {
        commonConfig: NodeFS.readFileSync(NodePath.join(common, "config"), "utf8"),
        root: git(checkout, "rev-parse", "--show-toplevel"),
        status: git(checkout, "status", "--porcelain"),
      };
    },
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("worktree-add", () => {
  it("roots a worktree made from a submodule checkout in itself before post-checkout runs", () => {
    using fixture = scratch();
    const checkout = fixture.submodule({ worktreeConfig: true });
    fixture.installHook(checkout);
    const before = fixture.snapshot(checkout);
    const worktree = NodePath.join(NodePath.dirname(checkout), "feature");

    // A lock reason of "--" must not swallow the script's own checkout control.
    const result = fixture.worktreeAdd(checkout, [
      "../feature",
      "-b",
      "feature",
      "--lock",
      "--reason",
      "--",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(fixture.git(worktree, "rev-parse", "--show-toplevel")).toBe(worktree);
    expect(fixture.git(worktree, "status", "--porcelain")).toBe("");
    expect(NodeFS.existsSync(NodePath.join(worktree, "README.md"))).toBe(true);
    expect(fixture.hookRuns()).toEqual([`${worktree} ${ZERO}`]);
    expect(fixture.snapshot(checkout)).toEqual(before);
    const common = NodePath.resolve(
      checkout,
      fixture.git(checkout, "rev-parse", "--git-common-dir"),
    );
    expect(NodeFS.existsSync(NodePath.join(common, "README.md"))).toBe(false);
  });

  it("keeps a worktree rooted in itself when the submodule turns on worktreeConfig later", () => {
    using fixture = scratch();
    const checkout = fixture.submodule({ worktreeConfig: false });
    const before = fixture.snapshot(checkout);
    const worktree = NodePath.join(NodePath.dirname(checkout), "feature");

    const result = fixture.worktreeAdd(checkout, ["../feature", "-b", "feature"]);

    expect(result.status, result.stderr).toBe(0);
    expect(fixture.snapshot(checkout)).toEqual(before);
    fixture.git(checkout, "config", "extensions.worktreeConfig", "true");
    expect(fixture.git(worktree, "rev-parse", "--show-toplevel")).toBe(worktree);
    expect(fixture.git(worktree, "status", "--porcelain")).toBe("");
  });

  it("creates a plain linked worktree in an ordinary repository", () => {
    using fixture = scratch();
    const checkout = fixture.repo("app");
    fixture.installHook(checkout);
    const before = fixture.snapshot(checkout);
    const worktree = NodePath.join(fixture.root, "feature");

    const result = fixture.worktreeAdd(checkout, ["../feature", "-b", "feature"]);

    expect(result.status, result.stderr).toBe(0);
    expect(fixture.git(worktree, "rev-parse", "--show-toplevel")).toBe(worktree);
    expect(fixture.hookRuns()).toEqual([`${worktree} ${ZERO}`]);
    expect(fixture.snapshot(checkout)).toEqual(before);
    const gitDir = fixture.git(worktree, "rev-parse", "--absolute-git-dir");
    expect(NodeFS.existsSync(NodePath.join(gitDir, "config.worktree"))).toBe(false);
  });

  it("ignores the repository variables a git hook passes down", () => {
    using fixture = scratch();
    const checkout = fixture.submodule({ worktreeConfig: true });
    fixture.installHook(checkout);
    NodeFS.writeFileSync(NodePath.join(checkout, "staged.txt"), "staged\n");
    fixture.git(checkout, "add", "staged.txt");
    const before = fixture.snapshot(checkout);
    const gitDir = fixture.git(checkout, "rev-parse", "--absolute-git-dir");
    const worktree = NodePath.join(NodePath.dirname(checkout), "feature");

    const result = fixture.worktreeAdd(checkout, ["../feature", "-b", "feature"], {
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: NodePath.join(gitDir, "index"),
      GIT_WORK_TREE: checkout,
      GIT_CONFIG: fixture.emptyConfig,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fixture.git(worktree, "rev-parse", "--show-toplevel")).toBe(worktree);
    expect(fixture.git(worktree, "status", "--porcelain")).toBe("");
    expect(fixture.hookRuns()).toEqual([`${worktree} ${ZERO}`]);
    expect(fixture.snapshot(checkout)).toEqual(before);
    expect(NodeFS.existsSync(NodePath.join(gitDir, "config.worktree"))).toBe(false);
  });

  it("refuses checkout options before creating anything", () => {
    using fixture = scratch();
    const checkout = fixture.submodule({ worktreeConfig: true });
    fixture.installHook(checkout);

    for (const option of ["--check", "--no-check"]) {
      const result = fixture.worktreeAdd(checkout, ["../feature", "-b", "feature", option]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("always checks out");
    }
    const orphan = fixture.worktreeAdd(checkout, ["../feature", "--orphan", "-b", "feature"]);
    expect(orphan.status).not.toBe(0);
    expect(orphan.stderr).toContain("git switch --orphan");
    expect(NodeFS.existsSync(NodePath.join(NodePath.dirname(checkout), "feature"))).toBe(false);
    expect(fixture.git(checkout, "branch", "--list", "feature")).toBe("");
    expect(fixture.hookRuns()).toEqual([]);
  });
});
