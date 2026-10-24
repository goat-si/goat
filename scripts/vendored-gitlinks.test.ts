// @effect-diagnostics nodeBuiltinImport:off - reads this repository's own git index.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const git = (...args: string[]) =>
  // The index listing is several megabytes, past execFileSync's 1 MiB default.
  NodeChildProcess.execFileSync("git", args, {
    cwd: repoRoot,
    env: isolatedGitEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

describe("vendored submodule gitlinks", () => {
  // actions/checkout runs `git submodule foreach` while removing credentials, and foreach dies
  // on a gitlink with no .gitmodules entry. A reference sync that brings one in must map it there.
  it("maps every gitlink in the index in .gitmodules", () => {
    const gitlinks = git("ls-files", "--stage")
      .split("\n")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.slice(line.indexOf("\t") + 1));
    if (gitlinks.length === 0) return;
    const mapped = new Set(
      git("config", "--file", ".gitmodules", "--get-regexp", String.raw`^submodule\..*\.path$`)
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => line.slice(line.indexOf(" ") + 1)),
    );
    expect(gitlinks.filter((path) => !mapped.has(path))).toEqual([]);
  });
});
