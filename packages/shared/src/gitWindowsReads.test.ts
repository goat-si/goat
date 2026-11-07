import { describe, expect, it } from "vite-plus/test";
import { runsGitWithoutConsole } from "./gitWindowsReads.ts";

describe("runsGitWithoutConsole", () => {
  const git = "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe";

  it.each([
    [["rev-parse", "--git-path", "index"], true],
    [["--git-dir", "C:\\repo\\.git", "symbolic-ref", "refs/remotes/origin/HEAD"], true],
    [["remote", "get-url", "--", "origin"], true],
    [["config", "--get", "branch.main.pushRemote"], true],
    [["symbolic-ref", "--quiet", "HEAD"], true],
    [["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true],
    [["rev-parse", "HEAD"], false],
    [["symbolic-ref", "HEAD", "refs/heads/x"], false],
    [["symbolic-ref", "-qd", "refs/remotes/origin/HEAD"], false],
    [["config", "--get", "--edit"], false],
    [["-c", "core.pager=x", "config", "--get", "user.name"], false],
  ])("Git for Windows %j without a console: %s", (args, expected) => {
    expect(runsGitWithoutConsole("win32", git, args)).toBe(expected);
  });

  it.each([
    ["win32", "C:\\Program Files\\Git\\cmd\\git.exe"],
    ["win32", "C:\\Users\\x\\scoop\\shims\\git.exe"],
    ["linux", git],
  ] as const)("keeps the console on %s for %s", (platform, executable) => {
    expect(runsGitWithoutConsole(platform, executable, ["rev-parse", "--show-toplevel"])).toBe(
      false,
    );
  });
});
