import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { REVIEW_METADATA_MAX_OUTPUT_BYTES } from "./reviewDiffArgs.ts";

type Options = {
  env?: NodeJS.ProcessEnv;
  allowNonZeroExit?: boolean;
  maxOutputBytes?: number;
  appendTruncationMarker?: boolean;
};
type Run = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: Options,
) => Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError>;
export const checkConflictMarkers = Effect.fn("GitVcsDriver.checkConflictMarkers")(function* (
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  executeGit: Run,
  readEmptyTreeHash: (cwd: string) => Effect.Effect<string, GitCommandError>,
) {
  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: Options = {},
  ) => executeGit(operation, cwd, args, options).pipe(Effect.map((result) => result.stdout));
  // add -A marks unmerged paths resolved, so refuse while one still has conflict markers.
  const unmergedPaths = (yield* runGitStdoutWithOptions(
    "GitVcsDriver.commit.unmergedPaths",
    cwd,
    ["-c", "diff.relative=false", "diff", "--name-only", "--diff-filter=U", "-z"],
    env ? { env } : {},
  ))
    .split("\0")
    .filter((file) => file.length > 0);
  if (unmergedPaths.length > 0) {
    const check = yield* executeGit(
      "GitVcsDriver.commit.conflictMarkers",
      cwd,
      [
        "-c",
        "diff.relative=false",
        "diff",
        "--check",
        "--no-color",
        "--",
        ...unmergedPaths.map((file) => `:(top,literal)${file}`),
      ],
      {
        ...(env ? { env } : {}),
        allowNonZeroExit: true,
        maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    );
    if (check.stdoutTruncated || (check.exitCode !== 0 && check.exitCode !== 2)) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.commit.conflictMarkers",
        command: "git diff --check",
        cwd,
        detail: "Could not verify merge conflict markers.",
      });
    }
    const reports = check.stdout.split("\n");
    const conflicted: string[] = [];
    let emptyTree: string | undefined;
    for (const file of unmergedPaths) {
      const markerLines = new Set(
        reports.flatMap((line) => {
          const match = line.startsWith(`${file}:`)
            ? /^(\d+): leftover conflict marker$/.exec(line.slice(file.length + 1))
            : null;
          return match ? [Number(match[1]) - 1] : [];
        }),
      );
      if (markerLines.size === 0) continue;
      emptyTree ??= yield* readEmptyTreeHash(cwd);
      const diff = yield* executeGit(
        "GitVcsDriver.commit.conflictMarkers",
        cwd,
        [
          "-c",
          "diff.relative=false",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--text",
          emptyTree,
          "--",
          `:(top,literal)${file}`,
        ],
        {
          ...(env ? { env } : {}),
          maxOutputBytes: REVIEW_METADATA_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );
      const diffLines = diff.stdout.split("\n");
      const hunk = diffLines.findIndex((line) => line.startsWith("@@"));
      if (diff.stdoutTruncated || hunk < 0) {
        return yield* new GitCommandError({
          operation: "GitVcsDriver.commit.conflictMarkers",
          command: "git diff",
          cwd,
          detail: `Could not check ${file} for conflict markers.`,
        });
      }
      const lines = diffLines
        .slice(hunk + 1)
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1));
      // Git also reports a lone "=======", which is valid content such as a heading underline.
      const reported = (marker: string) =>
        lines.some((line, index) => markerLines.has(index) && line.startsWith(marker));
      if (reported("<") && reported(">")) conflicted.push(file);
    }
    if (conflicted.length > 0) {
      return yield* new GitCommandError({
        operation: "GitVcsDriver.commit",
        command: "git commit",
        cwd,
        detail: `Cannot commit with unresolved merge conflicts in ${conflicted.join(", ")}. Resolve them, then commit.`,
      });
    }
  }
});
