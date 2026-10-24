// @effect-diagnostics nodeBuiltinImport:off - Vitest global setup, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isolatedGitEnv } from "./gitEnv.ts";

/**
 * Fails the run when a test changed this repository's git config (#1114). The repository is the
 * one git resolves for the run's own environment, so a run started from a hook checks the
 * checkout that hook belongs to. branch.* entries are left out because other worktrees of the
 * same repository write them (`git push -u`, `gh pr checkout`) while tests run.
 */
const resolveGitPath = (flag: string): string | undefined => {
  try {
    return NodeChildProcess.execFileSync("git", ["rev-parse", "--path-format=absolute", flag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const configFiles = (): ReadonlyArray<string> => {
  const commonDir = resolveGitPath("--git-common-dir");
  const gitDir = resolveGitPath("--git-dir");
  if (commonDir === undefined || gitDir === undefined) return [];
  return [
    ...new Set([NodePath.join(commonDir, "config"), NodePath.join(gitDir, "config.worktree")]),
  ];
};

// Ordered, because git applies the last of repeated keys: reordering them changes the value.
const readEntries = (file: string): ReadonlyArray<string> => {
  if (!NodeFS.existsSync(file)) return [];
  const output = NodeChildProcess.execFileSync("git", ["config", "--file", file, "--list", "-z"], {
    encoding: "utf8",
    env: isolatedGitEnv(),
  });
  return output
    .split("\0")
    .filter((entry) => entry !== "" && !entry.startsWith("branch."))
    .map((entry) => entry.replace("\n", "="));
};

export function setup(): () => void {
  const snapshots = configFiles().map((file) => ({ file, before: readEntries(file) }));
  return () => {
    const changes = snapshots.flatMap(({ file, before }) => {
      const after = readEntries(file);
      if (after.join("\0") === before.join("\0")) return [];
      const lines = [
        ...after.filter((entry) => !before.includes(entry)).map((entry) => `  + ${entry}`),
        ...before.filter((entry) => !after.includes(entry)).map((entry) => `  - ${entry}`),
      ];
      return [file, ...(lines.length > 0 ? lines : ["  (entries reordered or repeated)"])];
    });
    if (changes.length === 0) return;
    throw new Error(
      [
        "A test changed this repository's git config. Restore these entries, then find the git",
        "child that ran without isolatedGitEnv() from @goat/shared/testing/gitEnv (#1114):",
        ...changes,
      ].join("\n"),
    );
  };
}
