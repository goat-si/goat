"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  SOAK_MS,
  decideNightlyBuild,
  decideStablePromotion,
  nextStableBase,
  recheckStablePromotion,
} = require("./release-train.cjs");

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-25T06:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

const stable = (version, sha, publishedAt = ago(72 * HOUR)) => ({
  tag_name: "v" + version,
  name: "GOAT " + version + " (" + sha + ")",
  draft: false,
  prerelease: false,
  published_at: publishedAt,
});
const nightly = (version, sha, publishedAt) => ({
  tag_name: "v" + version,
  name: "GOAT Nightly " + version + " (" + sha + ")",
  draft: false,
  prerelease: true,
  published_at: publishedAt,
});

const releases = [
  nightly("0.1.2-nightly.20261024.250", "cccccccccccc", ago(3 * HOUR)),
  nightly("0.1.2-nightly.20261023.247", "bbbbbbbbbbbb", ago(SOAK_MS)),
  nightly("0.1.2-nightly.20261022.236", "aaaaaaaaaaaa", ago(36 * HOUR)),
  stable("0.1.1", "111111111111"),
  nightly("0.1.1-nightly.20261022.228", "000000000000", ago(80 * HOUR)),
];
const decide = (input = {}) =>
  decideStablePromotion({ releases, openBlockers: 0, hold: "", now: NOW, ...input });

describe("decideStablePromotion", () => {
  it("promotes the newest nightly that has soaked for 24 hours, exactly at the boundary", () => {
    assert.deepEqual(decide(), {
      promote: true,
      nightlyTag: "v0.1.2-nightly.20261023.247",
      shortSha: "bbbbbbbbbbbb",
      version: "0.1.2",
      reason: "v0.1.2-nightly.20261023.247 was published 24h ago and is newer than stable v0.1.1",
    });
  });

  it("passes over a nightly one millisecond short of 24 hours", () => {
    const younger = releases.map((release) =>
      release.tag_name === "v0.1.2-nightly.20261023.247"
        ? { ...release, published_at: ago(SOAK_MS - 1) }
        : release,
    );
    const result = decide({ releases: younger });
    assert.equal(result.promote, true);
    assert.equal(result.nightlyTag, "v0.1.2-nightly.20261022.236");
  });

  it("publishes nothing while an open issue is labeled release-blocker", () => {
    const result = decide({ openBlockers: 2 });
    assert.equal(result.promote, false);
    assert.match(result.reason, /2 open release-blocker/);
  });

  it("publishes nothing while GOAT_STABLE_HOLD is true, and ignores other values", () => {
    const held = decide({ hold: "true" });
    assert.equal(held.promote, false);
    assert.match(held.reason, /GOAT_STABLE_HOLD/);
    assert.equal(decide({ hold: "false" }).promote, true);
    assert.equal(decide({ hold: "" }).promote, true);
  });

  it("publishes nothing when no soaked nightly is newer than the current stable", () => {
    const result = decide({
      releases: [
        nightly("0.1.2-nightly.20261024.250", "cccccccccccc", ago(HOUR)),
        ...releases.slice(3),
      ],
    });
    assert.equal(result.promote, false);
    assert.match(result.reason, /no nightly newer than v0\.1\.1 has been published for 24h/);
  });

  it("does not promote a nightly again once it shipped as stable", () => {
    const promoted = [stable("0.1.2", "bbbbbbbbbbbb", ago(HOUR)), ...releases];
    const result = decide({ releases: promoted });
    assert.equal(result.promote, false);
    assert.match(result.reason, /newer than v0\.1\.2/);
    // A nightly of the next base whose commit already shipped stable is not promoted either.
    const reused = [
      nightly("0.1.3-nightly.20261023.251", "bbbbbbbbbbbb", ago(30 * HOUR)),
      ...promoted,
    ];
    assert.equal(decide({ releases: reused }).promote, false);
  });

  it("skips drafts and tags that are not nightlies", () => {
    const result = decide({
      releases: [
        { ...nightly("0.1.2-nightly.20261023.249", "dddddddddddd", ago(30 * HOUR)), draft: true },
        nightly("0.1.2-preview.20261023.1", "eeeeeeeeeeee", ago(30 * HOUR)),
        ...releases,
      ],
    });
    assert.equal(result.nightlyTag, "v0.1.2-nightly.20261023.247");
  });

  it("promotes a named nightly on a manual run without the soak, blocker or hold rules", () => {
    const result = decide({ sha: "cccccccccccc1234", openBlockers: 1, hold: "true" });
    assert.equal(result.promote, true);
    assert.equal(result.nightlyTag, "v0.1.2-nightly.20261024.250");
    assert.match(result.reason, /manual/);
  });

  it("refuses a named commit that is not a published nightly newer than stable", () => {
    assert.throws(() => decide({ sha: "999999999999" }), /not a published nightly/);
    assert.throws(() => decide({ sha: "000000000000" }), /not a published nightly/);
  });
});

describe("nextStableBase", () => {
  const tags = ["v0.1.2-nightly.20261023.247", "v0.1.1", "v0.1.0", "v0.1.1-nightly.20261022.228"];

  it("is the patch after the newest stable tag", () => {
    assert.equal(nextStableBase({ tags, packageVersion: "0.1.1" }), "0.1.2");
    assert.equal(nextStableBase({ tags: [...tags, "v0.1.2"], packageVersion: "0.1.2" }), "0.1.3");
  });

  it("keeps a higher version from the release manifests, so minor and major bumps still work", () => {
    assert.equal(nextStableBase({ tags, packageVersion: "0.2.0" }), "0.2.0");
  });

  it("starts from the manifests before any stable exists", () => {
    assert.equal(nextStableBase({ tags: [], packageVersion: "0.1.0" }), "0.1.0");
  });
});

describe("recheckStablePromotion", () => {
  const recheck = (input = {}) =>
    recheckStablePromotion({
      releases,
      openBlockers: 0,
      hold: "",
      shortSha: "bbbbbbbbbbbb",
      version: "0.1.2",
      manual: false,
      ...input,
    });

  it("lets a promotion publish while its gates stay clear", () => {
    assert.deepEqual(recheck(), { ok: true, reason: "bbbbbbbbbbbb is still promotable" });
  });

  it("stops a scheduled promotion when a blocker opens or the hold is set during the build", () => {
    assert.match(recheck({ openBlockers: 1 }).reason, /release-blocker/);
    assert.equal(recheck({ openBlockers: 1 }).ok, false);
    assert.equal(recheck({ hold: "true" }).ok, false);
  });

  it("lets a manual run that named its commit publish despite a blocker or the hold", () => {
    assert.equal(recheck({ manual: true, openBlockers: 3, hold: "true" }).ok, true);
  });

  it("stops any promotion overtaken by a stable of another commit during the build", () => {
    const overtaken = [stable("0.1.2", "cccccccccccc", ago(HOUR)), ...releases];
    assert.match(recheck({ releases: overtaken }).reason, /not newer than stable v0\.1\.2/);
    assert.equal(recheck({ releases: overtaken, manual: true }).ok, false);
    const newer = [stable("0.1.3", "dddddddddddd", ago(HOUR)), ...releases];
    assert.equal(recheck({ releases: newer }).ok, false);
  });

  it("lets a re-run finish once this exact stable is public, so the publisher can match its bytes", () => {
    const published = [stable("0.1.2", "bbbbbbbbbbbb", ago(HOUR)), ...releases];
    assert.deepEqual(recheck({ releases: published, openBlockers: 1, hold: "true" }), {
      ok: true,
      reason: "v0.1.2 of bbbbbbbbbbbb is already published; this is a re-run",
    });
    assert.equal(recheck({ releases: published, version: "0.1.3" }).ok, false);
  });

  it("stops a re-run of an older stable once a newer stable shipped, manual or not", () => {
    const later = [
      stable("0.1.3", "dddddddddddd", ago(HOUR / 2)),
      stable("0.1.2", "bbbbbbbbbbbb", ago(HOUR)),
      ...releases,
    ];
    assert.match(recheck({ releases: later }).reason, /newer stable v0\.1\.3/);
    assert.equal(recheck({ releases: later, manual: true }).ok, false);
  });
});

describe("decideNightlyBuild", () => {
  const GREEN = "eb2a07db09ab" + "0".repeat(28);
  // The newest nightly by version, published by a manual run that named a newer commit.
  const shipped = [
    nightly("0.1.2-nightly.20261024.263", "3065d73c3aaa", ago(2 * HOUR)),
    ...releases,
  ];
  const decideNightly = (input = {}) => {
    const calls = [];
    const status = input.status ?? "ahead";
    const result = decideNightlyBuild({
      releases: shipped,
      sha: GREEN,
      manual: false,
      compareStatus: (base, head) => {
        calls.push(base + "..." + head);
        return status;
      },
      ...input,
    });
    return { result, calls };
  };

  it("skips a green commit that is an ancestor of the newest published nightly's commit", () => {
    const { result, calls } = decideNightly({ status: "behind" });
    assert.equal(result.build, false);
    assert.match(result.reason, /older than v0\.1\.2-nightly\.20261024\.263 \(3065d73c3aaa\)/);
    assert.deepEqual(calls, ["3065d73c3aaa..." + GREEN]);
  });

  it("skips a green commit identical to the newest published nightly's commit", () => {
    assert.equal(decideNightly({ status: "identical" }).result.build, false);
  });

  it("builds a green commit that is newer than the newest published nightly's commit", () => {
    const { result, calls } = decideNightly({ status: "ahead" });
    assert.equal(result.build, true);
    assert.deepEqual(calls, ["3065d73c3aaa..." + GREEN]);
  });

  it("refuses a green commit whose history diverged from the newest published nightly's", () => {
    assert.throws(() => decideNightly({ status: "diverged" }), /diverged/);
  });

  it("skips a commit that is already a published nightly without comparing", () => {
    const { result, calls } = decideNightly({ sha: "aaaaaaaaaaaa" + "1".repeat(28) });
    assert.equal(result.build, false);
    assert.match(result.reason, /already a published nightly/);
    assert.deepEqual(calls, []);
  });

  it("builds a commit a manual run named even when it is older, without comparing", () => {
    const { result, calls } = decideNightly({ manual: true, status: "behind" });
    assert.equal(result.build, true);
    assert.deepEqual(calls, []);
    const again = decideNightly({ manual: true, sha: "3065d73c3aaa" + "2".repeat(28) });
    assert.equal(again.result.build, false);
  });

  it("builds when no nightly has been published, and ignores drafts when picking the newest", () => {
    const none = decideNightly({ releases: [stable("0.1.1", "111111111111")] });
    assert.equal(none.result.build, true);
    assert.deepEqual(none.calls, []);
    const draft = {
      ...nightly("0.1.2-nightly.20261025.270", "ffffffffffff", ago(HOUR)),
      draft: true,
    };
    const { calls } = decideNightly({ releases: [draft, ...shipped] });
    assert.deepEqual(calls, ["3065d73c3aaa..." + GREEN]);
  });

  it("refuses when the newest nightly's name does not carry its commit, instead of comparing an older one", () => {
    const unnamed = { ...shipped[0], name: "GOAT Nightly 0.1.2-nightly.20261024.263" };
    assert.throws(
      () => decideNightly({ releases: [unnamed, ...releases] }),
      /newest nightly v0\.1\.2-nightly\.20261024\.263 does not name its commit/,
    );
    assert.throws(() => decideNightly({ releases: [unnamed] }), /does not name its commit/);
    assert.equal(decideNightly({ releases: [unnamed], manual: true }).result.build, true);
  });

  it("compares with the newest nightly by version across bases, not by list position", () => {
    const nextBase = nightly("0.1.3-nightly.20261020.200", "999999999999", ago(90 * HOUR));
    const { calls } = decideNightly({ releases: [...shipped, nextBase] });
    assert.deepEqual(calls, ["999999999999..." + GREEN]);
  });
});
