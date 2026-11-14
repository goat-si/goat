import type * as GitVcsDriver from "./GitVcsDriver.ts";

export function splitNullSeparatedGitStdoutPaths(
  result: Pick<GitVcsDriver.ExecuteGitResult, "stdout" | "stdoutTruncated">,
): string[] {
  const parts = result.stdout.split("\0");
  if (result.stdoutTruncated && parts[parts.length - 1]?.length) parts.pop();
  return parts.filter((value) => value.length > 0);
}
