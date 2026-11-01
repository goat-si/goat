/**
 * The engine check runs as `node - <range>` on the remote host before GOAT knows which Node
 * it has. It is source text, not a stringified function: bundlers, Vite's SSR transform, and
 * coverage instrumentation rewrite function bodies and imported names, and a rewritten body
 * would reference bindings that do not exist on the remote. Keep it plain JavaScript that old
 * Node versions parse, with no references outside this string.
 *
 * Its range check matches `satisfiesSemverRange` in `@goat/shared/semver`;
 * remoteNodeEngineCheck.test.ts compares the two.
 */
export const REMOTE_NODE_ENGINE_CHECK_SCRIPT = String.raw`function satisfiesSemverRange(rawVersion, range) {
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
}
var range = process.argv[2] || "";
var rawVersion =
  process.versions && process.versions.node ? process.versions.node : process.version;
if (!satisfiesSemverRange(rawVersion, range)) {
  process.stderr.write(
    "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
  );
  process.exit(1);
}`;
