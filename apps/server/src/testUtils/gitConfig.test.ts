// @effect-diagnostics nodeBuiltinImport:off - Exercises the environment inherited by git.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";
import { expect, it } from "vite-plus/test";

it("ignores global insteadOf rewrites in git children", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-git-config-"));
  try {
    const repo = NodePath.join(home, "repo");
    NodeFS.mkdirSync(repo);
    NodeFS.writeFileSync(
      NodePath.join(home, ".gitconfig"),
      '[url "https://synthetic.invalid/"]\n  insteadOf = https://original.invalid/\n',
    );
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: NodePath.join(home, "xdg") };
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
    git("init", "-q");
    git("remote", "add", "origin", "https://original.invalid/repo");
    const output = git("remote", "-v");
    expect(output.includes("https://synthetic.invalid/")).toBe(false);
    expect(output.includes("https://original.invalid/repo")).toBe(true);
    const isolatedOutput = NodeChildProcess.execFileSync("git", ["remote", "-v"], {
      cwd: repo,
      env: isolatedGitEnv(env),
      encoding: "utf8",
    });
    expect(isolatedOutput).toBe(output);
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
