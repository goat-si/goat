import { compareRuntimeBuilds, parseSemver, type RuntimeBuild } from "@goat/shared/semver";

// A stamped prerelease follows an unstamped plain host build despite SemVer ordering.
export const compareHostRuntimeBuilds = (
  left: RuntimeBuild,
  right: RuntimeBuild,
): number | undefined => {
  const leftParsed = parseSemver(left.version);
  const rightParsed = parseSemver(right.version);
  const leftPlain = leftParsed?.prerelease.length === 0;
  if (
    leftParsed === null ||
    rightParsed === null ||
    leftPlain === (rightParsed.prerelease.length === 0)
  )
    return compareRuntimeBuilds(left, right);
  const [plain, prerelease] = leftPlain ? [left, right] : [right, left];
  if (prerelease.commitTime === undefined) return compareRuntimeBuilds(left, right);
  const plainNewer = plain.commitTime === undefined ? -1 : plain.commitTime - prerelease.commitTime;
  if (plainNewer === 0) return compareRuntimeBuilds(left, right);
  return leftPlain ? plainNewer : -plainNewer;
};
