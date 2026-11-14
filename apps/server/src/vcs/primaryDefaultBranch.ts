import type { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";
import { parseRemoteNamesInGitOrder } from "../git/remoteRefs.ts";

export function parseDefaultBranchFromRemoteHeadRef(
  value: string,
  remoteName: string,
): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

export const resolvePrimaryDefaultBranch = Effect.fn("GitVcsDriver.resolvePrimaryDefaultBranch")(
  function* (
    cwd: string,
    gitDirArgs: readonly string[],
    run: (
      operation: string,
      cwd: string,
      args: readonly string[],
      options?: { allowNonZeroExit?: boolean },
    ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
  ) {
    const read = (remote: string) =>
      run(
        "GitVcsDriver.resolveDefaultBranchName",
        cwd,
        [...gitDirArgs, "symbolic-ref", `refs/remotes/${remote}/HEAD`],
        { allowNonZeroExit: true },
      ).pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? parseDefaultBranchFromRemoteHeadRef(result.stdout, remote) : null,
        ),
      );
    const origin = yield* read("origin");
    if (origin !== null) return origin;
    const result = yield* run("GitVcsDriver.listRemoteNames", cwd, [...gitDirArgs, "remote"]);
    const names = parseRemoteNamesInGitOrder(result.stdout);
    const first = names[0];
    return first === undefined || names.includes("origin") ? null : yield* read(first);
  },
);
