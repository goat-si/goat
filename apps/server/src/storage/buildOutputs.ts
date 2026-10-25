import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isGitEntry, lstatOf } from "./fileState.ts";

/** How deep build outputs are looked for inside a worktree. */
const BUILD_OUTPUT_DEPTH = 3;
const SKIPPED_WHEN_SEARCHING = new Set([".git", "node_modules", "target", ".goat", ".t3"]);

/**
 * node_modules folders and Rust target/ folders next to a Cargo.toml, a few levels deep. A checkout
 * nested in the worktree is left out: the worktree's git cannot see its work.
 */
export const findBuildOutputs = Effect.fn("storage.findBuildOutputs")(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outputs: Array<string> = [];
  const pending: Array<{ readonly folder: string; readonly depth: number }> = [
    { folder: worktree, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { folder, depth } = next;
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    if (depth > 0 && names.some(isGitEntry)) continue;
    if (names.includes("node_modules")) outputs.push(path.join(folder, "node_modules"));
    if (names.includes("target") && names.includes("Cargo.toml"))
      outputs.push(path.join(folder, "target"));
    if (depth >= BUILD_OUTPUT_DEPTH) continue;
    for (const name of names) {
      if (SKIPPED_WHEN_SEARCHING.has(name) || name.startsWith(".")) continue;
      const child = path.join(folder, name);
      const stat = yield* lstatOf(child);
      if (stat !== null && stat.isDirectory && !stat.isLink)
        pending.push({ folder: child, depth: depth + 1 });
    }
  }
  return outputs;
});

/**
 * Why a build output may hold something an install or build would not bring back, or null when
 * git ignores it and tracks nothing in it. Its name proves nothing: a repository can commit files
 * under target/ or node_modules/, and those are its work.
 */
export const buildOutputKeeps = Effect.fn("storage.buildOutputKeeps")(function* (
  worktree: string,
  output: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const relative = path.relative(worktree, output);
  const run = (operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd: worktree, args, allowNonZeroExit: true, maxOutputBytes: 4096 })
      .pipe(Effect.orElseSucceed(() => null));
  const ignored = yield* run("storage.buildOutputIgnored", ["check-ignore", "-q", "--", relative]);
  if (ignored === null || (ignored.exitCode !== 0 && ignored.exitCode !== 1))
    return "git could not tell whether it ignores it";
  if (ignored.exitCode !== 0) return "git does not ignore it";
  const tracked = yield* run("storage.buildOutputTracked", ["ls-files", "-z", "--", relative]);
  if (tracked === null || tracked.exitCode !== 0) return "git could not list it";
  if (tracked.stdout.length > 0 || tracked.stdoutTruncated) return "git tracks files in it";
  return null;
});

/**
 * Why git status cannot vouch for a checkout's tracked files, or null when it can. A file marked
 * assume-unchanged is never compared with the index, and a skip-worktree file that is present on
 * disk is not compared either, so either can hold edits that git status and an unforced
 * `git worktree remove` both miss. Sparse checkouts mark absent files skip-worktree; those are fine.
 */
export const maskedIndexEntry = Effect.fn("storage.maskedIndexEntry")(function* (worktree: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const listed = yield* git
    .execute({
      operation: "storage.maskedIndexEntries",
      cwd: worktree,
      args: ["ls-files", "-v", "-z"],
      allowNonZeroExit: true,
      maxOutputBytes: 256 * 1024 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => null));
  if (listed === null || listed.exitCode !== 0 || listed.stdoutTruncated)
    return "git could not list its tracked files";
  for (const record of listed.stdout.split("\0")) {
    if (record.length < 3) continue;
    const tag = record.charAt(0);
    const file = record.slice(2);
    // ls-files -v prints a lower-case tag for an assume-unchanged entry.
    if (tag !== tag.toUpperCase()) return "git is told to assume " + file + " is unchanged";
    if (tag === "S" && (yield* lstatOf(path.join(worktree, file))) !== null)
      return file + " is outside its sparse checkout but present, so git does not compare it";
  }
  return null;
});
