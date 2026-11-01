interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
}

const SEMVER_NUMBER_SEGMENT = /^\d+$/;

export function normalizeSemverVersion(version: string): string {
  const trimmedVersion = version.trim();
  const suffixIndex = trimmedVersion.search(/[-+]/);
  const main = suffixIndex < 0 ? trimmedVersion : trimmedVersion.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? "" : trimmedVersion.slice(suffixIndex);
  const segments: string[] = [];
  for (const segment of (main ?? "").split(".")) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }

  while (segments.length > 0 && segments.length < 3) {
    segments.push("0");
  }

  return `${segments.join(".")}${suffix}`;
}

export function parseSemver(value: string): ParsedSemver | null {
  const normalized = normalizeSemverVersion(value).replace(/^v/, "");
  const match =
    /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      normalized,
    );
  if (!match) return null;
  const [, main = "", prerelease] = match;
  if (prerelease?.split(".").some((part) => /^0\d+$/.test(part))) return null;
  const segments = main.split(".");
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }
  if (
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: parsePrereleaseSegments(prerelease),
  };
}

function parsePrereleaseSegments(prerelease: string | undefined): ReadonlyArray<string> {
  if (prerelease === undefined) {
    return [];
  }
  const segments: string[] = [];
  for (const segment of prerelease.split(".")) {
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }
  return segments;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = SEMVER_NUMBER_SEGMENT.test(left);
  const rightNumeric = SEMVER_NUMBER_SEGMENT.test(right);

  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) return left.length - right.length;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

/** A GOAT runtime build: its exact version and, when the build recorded it, its commit time. */
export interface RuntimeBuild {
  readonly version: string;
  /** Unix seconds of the commit the build was made from. */
  readonly commitTime?: number | undefined;
}

// A dev build's identifier is a commit sha, and a sha can be all digits, so dev is never numbered.
const isNumberedTrain = (prerelease: ReadonlyArray<string>) =>
  prerelease.length > 1 &&
  prerelease[0] !== "dev" &&
  prerelease.slice(1).every((part) => SEMVER_NUMBER_SEGMENT.test(part));

// `<base>-dev.<commit unix time>.g<sha>` (scripts/lib/release-version.ts) carries its own commit time.
const devVersionCommitTime = (prerelease: ReadonlyArray<string>) => {
  const [train, time, sha] = prerelease;
  return prerelease.length === 3 &&
    train === "dev" &&
    time !== undefined &&
    /^[1-9]\d{0,15}$/.test(time) &&
    sha !== undefined &&
    /^g[0-9a-f]{7,40}$/.test(sha)
    ? Number(time)
    : undefined;
};

/**
 * Orders two runtime builds, or returns `undefined` when nothing proves an order.
 *
 * A different core version orders by SemVer. Numbered builds of one train
 * (`0.1.0-nightly.20261012.2`) order by SemVer too. Every other pair of one
 * core, such as `0.1.0-dev.<sha>` builds or a dev build against a nightly,
 * orders only by commit time, because SemVer would compare the sha or train
 * name alphabetically. A `<base>-dev.<time>.g<sha>` version supplies its own
 * commit time when the build did not report one. Without both commit times
 * such a pair has no order.
 */
export function compareRuntimeBuilds(left: RuntimeBuild, right: RuntimeBuild): number | undefined {
  if (left.version === right.version) return 0;
  const a = parseSemver(left.version);
  const b = parseSemver(right.version);
  if (a === null || b === null) return undefined;
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (
    isNumberedTrain(a.prerelease) &&
    isNumberedTrain(b.prerelease) &&
    a.prerelease[0] === b.prerelease[0]
  )
    return compareSemverVersions(left.version, right.version);
  const leftTime = left.commitTime ?? devVersionCommitTime(a.prerelease);
  const rightTime = right.commitTime ?? devVersionCommitTime(b.prerelease);
  if (leftTime === undefined || rightTime === undefined) return undefined;
  return leftTime - rightTime;
}

/** The SSH remote engine check in `@goat/ssh` carries a source copy of this; keep them in step. */
export const satisfiesSemverRange: (rawVersion: string, range: string) => boolean =
  function satisfiesSemverRange(rawVersion, range) {
    const normalizedVersion = String(rawVersion).trim().replace(/^v/, "");
    const versionMatch = normalizedVersion.match(
      /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/,
    );
    if (!versionMatch) {
      return false;
    }

    const version = {
      major: Number(versionMatch[1]),
      minor: Number(versionMatch[2] || 0),
      patch: Number(versionMatch[3] || 0),
    };

    return range.split("||").some((group) => {
      const comparators = group.trim().split(/\s+/).filter(Boolean);
      if (comparators.length === 0) {
        return false;
      }
      return comparators.every((comparator) => {
        const match = comparator.trim().match(/^(\^|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
        if (!match) {
          return false;
        }
        const targetVersion = match[2];
        if (targetVersion === undefined) {
          return false;
        }
        const targetMatch = targetVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
        if (!targetMatch) {
          return false;
        }
        const target = {
          major: Number(targetMatch[1]),
          minor: Number(targetMatch[2] || 0),
          patch: Number(targetMatch[3] || 0),
        };
        const compared =
          version.major !== target.major
            ? version.major > target.major
              ? 1
              : -1
            : version.minor !== target.minor
              ? version.minor > target.minor
                ? 1
                : -1
              : version.patch !== target.patch
                ? version.patch > target.patch
                  ? 1
                  : -1
                : 0;
        const operator = match[1] || "=";
        switch (operator) {
          case "^":
            if (compared < 0) {
              return false;
            }
            if (target.major > 0) {
              return version.major === target.major;
            }
            if (target.minor > 0) {
              return version.major === 0 && version.minor === target.minor;
            }
            return version.major === 0 && version.minor === 0 && version.patch === target.patch;
          case ">=":
            return compared >= 0;
          case ">":
            return compared > 0;
          case "<=":
            return compared <= 0;
          case "<":
            return compared < 0;
          case "=":
            return compared === 0;
          default:
            return false;
        }
      });
    });
  };
