import * as Effect from "effect/Effect";
import type { GitCommandError } from "@goat/contracts";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";

export function makeRemoteRefContainsHead(
  executeGit: (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: { readonly allowNonZeroExit: boolean },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) {
  const remoteRefContainsHead = (cwd: string, remoteRef: string) =>
    executeGit(
      "GitVcsDriver.pushCurrentBranch.publishContainsHead",
      cwd,
      ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/${remoteRef}`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => result.exitCode === 0),
      Effect.orElseSucceed(() => false),
    );

  return remoteRefContainsHead;
}

export const pushesOnlyToFetchUrl = Effect.fn("GitVcsDriver.pushesOnlyToFetchUrl")(
  function* (
    runGitStdout: (
      operation: string,
      cwd: string,
      args: readonly string[],
    ) => Effect.Effect<string, GitCommandError>,
    cwd: string,
    remoteName: string,
  ) {
    const [fetchUrl, pushUrls] = yield* Effect.all([
      runGitStdout("GitVcsDriver.pushesOnlyToFetchUrl.fetchUrl", cwd, [
        "remote",
        "get-url",
        "--",
        remoteName,
      ]),
      runGitStdout("GitVcsDriver.pushesOnlyToFetchUrl.pushUrls", cwd, [
        "remote",
        "get-url",
        "--push",
        "--all",
        "--",
        remoteName,
      ]),
    ]);
    return (
      fetchUrl.endsWith("\n") && !fetchUrl.slice(0, -1).includes("\n") && pushUrls === fetchUrl
    );
  },
  Effect.orElseSucceed(() => false),
);

export function liveUpstreamRef(status: string, upstreamRef: string | null) {
  const records = status.split("\0");
  return records.some(
    (line) => line.startsWith("# branch.ab ") || line === "# branch.oid (initial)",
  )
    ? upstreamRef
    : null;
}

export const isAliasOfUpstreamHead = (
  branch: string,
  upstreamBranch: string,
  upstreamRef: string,
) =>
  branch === upstreamBranch ||
  (branch.endsWith(`/${upstreamBranch}`) && upstreamRef.endsWith(`/${branch}`));

export const resolveGonePushDestination = Effect.fn("GitVcsDriver.resolveGonePushDestination")(
  function* (
    cwd: string,
    branch: string,
    readConfig: (cwd: string, key: string) => Effect.Effect<string | null, GitCommandError>,
    resolveRemote: (
      cwd: string,
      branch: string,
      fallback: string | null,
    ) => Effect.Effect<string | null, GitCommandError>,
    resolveBranch: (cwd: string, branch: string, remote: string) => Effect.Effect<string>,
  ) {
    const mergeRef = yield* readConfig(cwd, `branch.${branch}.merge`);
    const mergeBranch = mergeRef?.startsWith("refs/heads/")
      ? mergeRef.slice("refs/heads/".length)
      : null;
    const configuredRemoteName = yield* readConfig(cwd, `branch.${branch}.remote`);
    const gone =
      mergeBranch && configuredRemoteName && configuredRemoteName !== "."
        ? {
            remoteName: configuredRemoteName,
            branchName: mergeBranch,
            upstreamRef: `${configuredRemoteName}/${mergeBranch}`,
          }
        : null;
    const own = gone !== null && isAliasOfUpstreamHead(branch, gone.branchName, gone.upstreamRef);
    const remoteName = yield* resolveRemote(cwd, branch, own ? gone.remoteName : null);
    if (!remoteName) return null;
    const branchName = own
      ? gone.branchName
      : configuredRemoteName === "."
        ? branch
        : yield* resolveBranch(cwd, branch, remoteName);
    return {
      remoteName,
      branchName,
      publishes: true as const,
      upstream: own ? null : gone,
      pushRemote: null,
    };
  },
);
