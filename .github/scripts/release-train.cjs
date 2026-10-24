"use strict";

// The release train's decisions (docs/internals/release-channels.md). goat-nightly.yml runs this
// file from its own commit (GITHUB_WORKFLOW_SHA), never from the commit it builds, so an older
// nightly commit is promoted under today's rules.
//
//   node release-train.cjs stable   decide whether to promote a nightly to stable
//   node release-train.cjs recheck  before publishing, check that promotion still holds
//   node release-train.cjs base     print the base version the next nightly or stable carries
//   node release-train.cjs nightly  decide whether to build a nightly of a dev commit
//
// Stable promotes the newest published nightly that has been out for 24 hours and is newer than
// the current stable, unless an open issue is labeled release-blocker or the repository variable
// GOAT_STABLE_HOLD is 'true'. It rebuilds that nightly's commit with the plain base version. A
// manual run that names a commit promotes that nightly without the three rules.
//
// A nightly builds the newest green dev commit unless it is already a published nightly or is
// not newer than the commit of the newest published nightly: a manual run may have shipped a
// newer commit, and building an older one would give users older code under a higher version.
// A manual run that names a commit builds it unless it is already a published nightly.

const childProcess = require("node:child_process");
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
/** The current stable and the published nightlies a promotion may still pick, newest first. */
function promotable(releases) {
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
  return { currentLabel, candidates };
}

/** The gates that stop an automatic promotion, or undefined when none holds. */
function heldBy({ openBlockers, hold }) {
  if (hold === "true") return "repository variable GOAT_STABLE_HOLD is 'true'";
  if (openBlockers > 0) return openBlockers + " open " + BLOCKER_LABEL + " issue(s)";
  return undefined;
}

/**
 * Whether to build a nightly of sha. compareStatus(base, head) returns GitHub's compare status
 * of head against base. Returns {build, reason}; throws when sha and the newest published
 * nightly's commit have diverged, since neither is then the newer one.
 */
function decideNightlyBuild({ releases, sha, manual, compareStatus }) {
  const shortSha = sha.toLowerCase().slice(0, 12);
  const nightlies = releases.filter((release) => release.prerelease);
  if (nightlies.some((release) => NAME_SHA.exec(release.name ?? "")?.[1] === shortSha)) {
    return { build: false, reason: sha + " is already a published nightly" };
  }
  if (manual) return { build: true, reason: "manual run named " + sha };
  const newest = nightlies
    .filter((release) => !release.draft && release.published_at)
    .map((release) => {
      const match = NIGHTLY_TAG.exec(release.tag_name);
      const builtSha = NAME_SHA.exec(release.name ?? "")?.[1];
      return match && builtSha ? { release, builtSha, order: numbers(match, 5) } : undefined;
    })
    .filter(Boolean)
    .sort((a, b) => compare(b.order, a.order))[0];
  if (newest === undefined) return { build: true, reason: "no nightly has been published" };
  const label = newest.release.tag_name + " (" + newest.builtSha + ")";
  const status = compareStatus(newest.builtSha, sha);
  if (status === "ahead") return { build: true, reason: sha + " is newer than " + label };
  if (status === "behind") return { build: false, reason: sha + " is older than " + label };
  if (status === "identical") return { build: false, reason: sha + " is the commit of " + label };
  throw new Error(
    sha + " and the commit of " + label + " have diverged (" + status + "); name a commit to build",
  );
}

function decideStablePromotion({ releases, openBlockers, hold, now, sha }) {
  const { currentLabel, candidates } = promotable(releases);
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
  const held = heldBy({ openBlockers, hold });
  if (held) return { promote: false, reason: held };
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

/**
 * Checked again right before a promotion publishes, hours after prepare decided: a blocker
 * opened or the hold set during the build stops a scheduled promotion, and a stable that
 * shipped meanwhile stops any. A manual run that named its commit skips the two gates. A
 * re-run after this exact stable went public passes, so the publisher can match its bytes and
 * finish the steps after it.
 */
function recheckStablePromotion({ releases, openBlockers, hold, shortSha, version, manual }) {
  // A newer stable comes first: re-running an older one would publish its runtime release
  // as latest on goat-si/goat after the newer one.
  const newest = newestStable(
    releases
      .filter((release) => !release.draft && !release.prerelease && release.published_at)
      .map((release) => release.tag_name),
  );
  if (newest !== undefined && compare(newest, parsePlain(version)) > 0) {
    return { ok: false, reason: "a newer stable v" + format(newest) + " shipped during the build" };
  }
  const published = releases.some(
    (release) =>
      !release.draft &&
      !release.prerelease &&
      release.published_at &&
      release.tag_name === "v" + version &&
      NAME_SHA.exec(release.name ?? "")?.[1] === shortSha,
  );
  if (published) {
    return {
      ok: true,
      reason: "v" + version + " of " + shortSha + " is already published; this is a re-run",
    };
  }
  if (!manual) {
    const held = heldBy({ openBlockers, hold });
    if (held) return { ok: false, reason: held };
  }
  const { currentLabel, candidates } = promotable(releases);
  if (!candidates.some((nightly) => nightly.shortSha === shortSha)) {
    return {
      ok: false,
      reason:
        shortSha + " is not newer than stable " + currentLabel + " or already shipped as stable",
    };
  }
  return { ok: true, reason: shortSha + " is still promotable" };
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
  const blockerCount = () => {
    const blockers = Number(env.OPEN_BLOCKERS);
    if (env.OPEN_BLOCKERS === undefined || !Number.isInteger(blockers) || blockers < 0) {
      throw new Error("OPEN_BLOCKERS must be a count, got '" + env.OPEN_BLOCKERS + "'");
    }
    return blockers;
  };
  if (command === "recheck") {
    const result = recheckStablePromotion({
      releases: readJsonLines(env.RELEASES_FILE),
      openBlockers: blockerCount(),
      hold: env.GOAT_STABLE_HOLD ?? "",
      shortSha: env.SHORT_SHA,
      version: env.VERSION,
      manual: Boolean(env.INPUT_SHA),
    });
    if (!result.ok) throw new Error("stable promotion stopped before publishing: " + result.reason);
    console.log("stable promotion: " + result.reason);
    return;
  }
  if (command === "stable") {
    const blockers = blockerCount();
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
  if (command === "nightly") {
    const sha = env.SHA ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new Error("SHA must be a full commit sha, got '" + sha + "'");
    const decision = decideNightlyBuild({
      releases: readJsonLines(env.RELEASES_FILE),
      sha,
      manual: Boolean(env.INPUT_SHA),
      compareStatus: (base, head) =>
        childProcess
          .execFileSync(
            "gh",
            ["api", "repos/goat-si/goat/compare/" + base + "..." + head, "--jq", ".status"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
          )
          .trim(),
    });
    console.error("nightly: " + decision.reason);
    console.log("build=" + decision.build);
    return;
  }
  throw new Error("usage: release-train.cjs stable|recheck|base|nightly");
}

module.exports = {
  SOAK_MS,
  BLOCKER_LABEL,
  decideNightlyBuild,
  decideStablePromotion,
  nextStableBase,
  recheckStablePromotion,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("::error::" + error.message);
    process.exit(1);
  }
}
