import { parseRemoteRefWithRemoteNames } from "../git/remoteRefs.ts";

export function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

/** Without an origin remote, the first remote in git order supplies the fallback default branch. */
export function fallbackDefaultRemote(
  originDefaultBranch: string | null,
  remoteNamesInGitOrder: ReadonlyArray<string>,
): string | null {
  const [firstRemoteName] = remoteNamesInGitOrder;
  return originDefaultBranch === null &&
    firstRemoteName !== undefined &&
    !remoteNamesInGitOrder.includes("origin")
    ? firstRemoteName
    : null;
}
