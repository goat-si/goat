// The GOAT version rule (docs/internals/release-channels.md#version-rule). Every build carries one
// version, stamped into all four release manifests, so the desktop bundle, the server it
// packages and the SSH runtime archive report the same string. Only a published stable
// release is a bare x.y.z; everything else is an ordered prerelease of that base:
//   nightly  <base>-nightly.<YYYYMMDD>.<run>   (resolve-nightly-release.ts)
//   preview  <base>-preview.<YYYYMMDD>.<run>, PR builds <base>-pr.<pr>.<run>
//   local    <base>-dev.<commit unix time>.g<sha>
import { cliReleaseChannelOf } from "@goat/shared/cliRelease";
import { compareSemverVersions, parseSemver } from "@goat/shared/semver";

const PLAIN_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** Stamps one version into every release manifest. */
export const RELEASE_VERSION_STAMP_COMMAND = "node scripts/update-release-package-versions.ts";

export const isPlainReleaseVersion = (version: string): boolean => PLAIN_VERSION.test(version);

export const releaseBaseVersion = (version: string): string => version.replace(/[-+].*$/, "");

export function nextPatchVersion(version: string): string {
  const [major = "0", minor = "0", patch = "0"] = releaseBaseVersion(version).split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * The version of a local or otherwise unpublished build of `baseVersion`. The commit time
 * orders two dev builds (a numeric prerelease identifier compares numerically) and the sha
 * keeps builds of different commits apart. Returns undefined when an input is missing, so the
 * caller asks for an explicit version instead of falling back to the bare base.
 */
export function resolveDevBuildVersion(input: {
  readonly baseVersion: string;
  readonly commitTime: string;
  readonly commitSha: string;
}): string | undefined {
  const base = releaseBaseVersion(input.baseVersion);
  const commitTime = input.commitTime.trim();
  const sha = input.commitSha.trim().toLowerCase();
  if (!isPlainReleaseVersion(base)) return undefined;
  if (!/^[1-9]\d{0,15}$/.test(commitTime)) return undefined;
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return undefined;
  return `${base}-dev.${commitTime}.g${sha.slice(0, 9)}`;
}

const publishedVersions = (tags: ReadonlyArray<string>): string[] =>
  tags
    .map((tag) => /^v(\S+)$/.exec(tag.trim())?.[1])
    .filter((version): version is string => version !== undefined && parseSemver(version) !== null);

const newest = (versions: ReadonlyArray<string>): string | undefined =>
  versions.toSorted(compareSemverVersions).at(-1);

/**
 * Problems that stop `candidate` from being published beside `publishedTags` (the tag names
 * of goat-si/goat-releases). A release must sort above the newest stable and above the
 * previous build on its own channel, or installs and SSH runtime refresh never pick it up.
 */
export function checkReleaseCandidate(input: {
  readonly candidate: string;
  readonly publishedTags: ReadonlyArray<string>;
}): string[] {
  const { candidate } = input;
  if (parseSemver(candidate) === null) return [`${candidate} is not a semver version`];
  const channel = cliReleaseChannelOf(candidate);
  const base = releaseBaseVersion(candidate);
  const published = publishedVersions(input.publishedTags);
  const bump = (from: string) =>
    `Bump the base on dev with \`${RELEASE_VERSION_STAMP_COMMAND} ${nextPatchVersion(from)}\` (it rewrites the four release manifests; merge that as a PR), then rerun this workflow.`;

  if (published.includes(base)) {
    return [
      channel === "stable"
        ? `v${base} is already published as stable. ${bump(base)}`
        : `v${base} is already published as stable, so ${candidate} would sort below it and no install would update to it. ${bump(base)}`,
    ];
  }

  const problems: string[] = [];
  const stable = newest(published.filter((version) => cliReleaseChannelOf(version) === "stable"));
  if (stable !== undefined && compareSemverVersions(candidate, stable) <= 0) {
    problems.push(`${candidate} does not sort above the newest stable v${stable}. ${bump(stable)}`);
  }
  if (channel !== "stable") {
    const previous = newest(
      published.filter((version) => cliReleaseChannelOf(version) === channel),
    );
    if (previous !== undefined && compareSemverVersions(candidate, previous) <= 0) {
      problems.push(
        `${candidate} does not sort above the previous ${channel} v${previous}; the run number or base went backwards.`,
      );
    }
  }
  return problems;
}
