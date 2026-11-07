export function resolveLastKnownPr<
  T extends {
    readonly pr: unknown;
    readonly upstreamRef: string | null;
    readonly headBranch: string;
    readonly remoteName: string | null;
    readonly headRemoteUrlKey: string | null;
  },
>(
  lastKnown: T | undefined,
  current: Pick<T, "upstreamRef" | "headBranch" | "remoteName" | "headRemoteUrlKey">,
): T | null {
  if (!lastKnown || lastKnown.headBranch !== current.headBranch) return null;
  if (lastKnown.headRemoteUrlKey !== null && current.headRemoteUrlKey !== null) {
    return lastKnown.headRemoteUrlKey === current.headRemoteUrlKey ? lastKnown : null;
  }
  if (
    lastKnown.upstreamRef !== null &&
    current.upstreamRef !== null &&
    lastKnown.remoteName !== null &&
    current.remoteName !== null
  ) {
    return lastKnown.remoteName === current.remoteName ? lastKnown : null;
  }
  return lastKnown;
}
