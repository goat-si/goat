"use strict";

// The release train's decisions (docs/internals/release-channels.md). goat-nightly.yml runs this
// file from its own commit (GITHUB_WORKFLOW_SHA), never from the commit it builds, so an older
// nightly commit is promoted under today's rules.
//
//   node release-train.cjs stable   decide whether to promote a nightly to stable
//   node release-train.cjs base     print the base version the next nightly or stable carries
//
// Stable promotes the newest published nightly that has been out for 24 hours and is newer than
// the current stable, unless an open issue is labeled release-blocker or the repository variable
// GOAT_STABLE_HOLD is 'true'. It rebuilds that nightly's commit with the plain base version. A
// manual run that names a commit promotes that nightly without the three rules.

const fs = require("node:fs");

const SOAK_MS = 24 * 60 * 60 * 1000;
const BLOCKER_LABEL = "release-blocker";
const NIGHTLY_TAG = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;
const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
/** Release names end with the built commit: "GOAT Nightly <version> (<sha12>)". */
const NAME_SHA = /\(([0-9a-f]{12})\)\s*$/;

const numbers = (match, count) => match.slice(1, 1 + count).map(Number);
const compare = (a, b) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
const format = (parts) => parts.join(".");
const parsePlain = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error("not a plain x.y.z version: " + version);
  return numbers(match, 3);
};

/** The newest published stable as [major, minor, patch], or undefined. */
function newestStable(tags) {
  return tags
    .map((tag) => STABLE_TAG.exec(tag))
    .filter(Boolean)
    .map((match) => numbers(match, 3))
    .sort(compare)
    .at(-1);
}

/**
 * The plain version the next nightly is a prerelease of, and the version a stable promotion of
 * it ships: the patch after the newest stable tag, or the release manifests' version when that
 * is higher (a deliberate minor or major bump).
 */
function nextStableBase({ tags, packageVersion }) {
  const manifest = parsePlain(packageVersion);
  const latest = newestStable(tags);
  if (latest === undefined) return format(manifest);
  const next = [latest[0], latest[1], latest[2] + 1];
  return format(compare(manifest, next) > 0 ? manifest : next);
}

/**
 * Whether to promote a nightly now. releases are goat-releases releases ({tag_name, name, draft,
 * prerelease, published_at}); sha is the commit a manual run named, if any. Returns
 * {promote: true, nightlyTag, shortSha, version, reason} or {promote: false, reason}, and throws
 * when a named commit is not a promotable nightly.
 */
function decideStablePromotion({ releases, openBlockers, hold, now, sha }) {
  const published = releases.filter((release) => !release.draft && release.published_at);
  const stables = published.filter(
    (release) => !release.prerelease && STABLE_TAG.test(release.tag_name),
  );
  const current = newestStable(stables.map((release) => release.tag_name));
  const currentLabel = current === undefined ? "none" : "v" + format(current);
  const shipped = new Set(stables.map((release) => NAME_SHA.exec(release.name ?? "")?.[1]));
  const candidates = published
    .filter((release) => release.prerelease)
    .map((release) => {
      const match = NIGHTLY_TAG.exec(release.tag_name);
      const shortSha = NAME_SHA.exec(release.name ?? "")?.[1];
      if (!match || !shortSha) return undefined;
      return { release, shortSha, order: numbers(match, 5), base: numbers(match, 3) };
    })
    .filter(Boolean)
    .filter((nightly) => current === undefined || compare(nightly.base, current) > 0)
    .filter((nightly) => !shipped.has(nightly.shortSha))
    .sort((a, b) => compare(b.order, a.order));
  const promote = (nightly, reason) => ({
    promote: true,
    nightlyTag: nightly.release.tag_name,
    shortSha: nightly.shortSha,
    version: format(nightly.base),
    reason,
  });

  if (sha) {
    const wanted = sha.toLowerCase();
    const named = candidates.find((nightly) => wanted.startsWith(nightly.shortSha));
    if (!named) {
      throw new Error(
        sha +
          " is not a published nightly newer than stable " +
          currentLabel +
          " that has not shipped as stable",
      );
    }
    return promote(named, "manual run named " + named.release.tag_name);
  }
  if (hold === "true") {
    return { promote: false, reason: "repository variable GOAT_STABLE_HOLD is 'true'" };
  }
  if (openBlockers > 0) {
    return {
      promote: false,
      reason: openBlockers + " open " + BLOCKER_LABEL + " issue(s)",
    };
  }
  const soaked = candidates.find(
    (nightly) => now - Date.parse(nightly.release.published_at) >= SOAK_MS,
  );
  if (!soaked) {
    return {
      promote: false,
      reason: "no nightly newer than " + currentLabel + " has been published for 24h",
    };
  }
  const hours = Math.floor((now - Date.parse(soaked.release.published_at)) / (60 * 60 * 1000));
  return promote(
    soaked,
    soaked.release.tag_name +
      " was published " +
      hours +
      "h ago and is newer than stable " +
      currentLabel,
  );
}

/** One JSON object per line, as gh api --paginate --jq '.[] | {...}' prints them. */
const readJsonLines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

function main(argv = process.argv.slice(2), env = process.env) {
  const [command] = argv;
  if (command === "base") {
    const tags = fs.readFileSync(env.RELEASE_TAGS_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    console.log(nextStableBase({ tags, packageVersion: env.PACKAGE_VERSION }));
    return;
  }
  if (command === "stable") {
    const blockers = Number(env.OPEN_BLOCKERS);
    if (!Number.isInteger(blockers) || blockers < 0) {
      throw new Error("OPEN_BLOCKERS must be a count, got '" + env.OPEN_BLOCKERS + "'");
    }
    const decision = decideStablePromotion({
      releases: readJsonLines(env.RELEASES_FILE),
      openBlockers: blockers,
      hold: env.GOAT_STABLE_HOLD ?? "",
      now: Date.now(),
      sha: env.INPUT_SHA || undefined,
    });
    console.error("stable promotion: " + decision.reason);
    const lines = decision.promote
      ? [
          "promote=true",
          "short_sha=" + decision.shortSha,
          "version=" + decision.version,
          "nightly_tag=" + decision.nightlyTag,
        ]
      : ["promote=false"];
    console.log(lines.join("\n"));
    return;
  }
  throw new Error("usage: release-train.cjs stable|base");
}

module.exports = { SOAK_MS, BLOCKER_LABEL, decideStablePromotion, nextStableBase };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("::error::" + error.message);
    process.exit(1);
  }
}
