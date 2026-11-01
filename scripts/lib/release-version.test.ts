import { describe, expect, it } from "vite-plus/test";

import { compareRuntimeBuilds, compareSemverVersions } from "@goat/shared/semver";

import {
  checkReleaseCandidate,
  nextPatchVersion,
  resolveDevBuildVersion,
} from "./release-version.ts";

describe("resolveDevBuildVersion", () => {
  it("orders dev builds by commit time and keeps the sha", () => {
    const older = resolveDevBuildVersion({
      baseVersion: "0.1.0",
      commitTime: "1792000000",
      commitSha: "FFF881545abc",
    });
    const newer = resolveDevBuildVersion({
      baseVersion: "0.1.0",
      commitTime: "1792000100",
      commitSha: "0012345678",
    });
    expect(older).toBe("0.1.0-dev.1792000000.gfff881545");
    expect(newer).toBe("0.1.0-dev.1792000100.g001234567");
    expect(compareSemverVersions(newer!, older!)).toBeGreaterThan(0);
    expect(compareSemverVersions(newer!, "0.1.0")).toBeLessThan(0);
    // SSH runtime refresh orders them even when neither build reported its commit time.
    expect(compareRuntimeBuilds({ version: newer! }, { version: older! })).toBeGreaterThan(0);
    expect(
      compareRuntimeBuilds({ version: older! }, { version: "0.1.0-nightly.20261012.2" }),
    ).toBeUndefined();
  });

  it("never falls back to the bare base", () => {
    expect(
      resolveDevBuildVersion({ baseVersion: "0.1.0", commitTime: "", commitSha: "abcdef1" }),
    ).toBeUndefined();
    expect(
      resolveDevBuildVersion({
        baseVersion: "0.1.0",
        commitTime: "1792000000",
        commitSha: "unknown",
      }),
    ).toBeUndefined();
  });
});

describe("checkReleaseCandidate", () => {
  const tags = ["v0.1.0-nightly.20261012.2", "v0.1.0-nightly.20261012.1", "v0.0.45"];

  it("accepts the next nightly", () => {
    expect(
      checkReleaseCandidate({ candidate: "0.1.0-nightly.20261013.3", publishedTags: tags }),
    ).toEqual([]);
    expect(
      checkReleaseCandidate({ candidate: "0.1.0-nightly.20261013.3", publishedTags: [] }),
    ).toEqual([]);
  });

  it("refuses a nightly that does not sort above the previous one", () => {
    expect(
      checkReleaseCandidate({ candidate: "0.1.0-nightly.20261012.2", publishedTags: tags }),
    ).toEqual([expect.stringContaining("previous nightly v0.1.0-nightly.20261012.2")]);
    expect(
      checkReleaseCandidate({ candidate: "0.1.0-nightly.20261011.9", publishedTags: tags }),
    ).toHaveLength(1);
  });

  it("names the bump once the base shipped as stable", () => {
    const problems = checkReleaseCandidate({
      candidate: "0.1.0-nightly.20261020.9",
      publishedTags: [...tags, "v0.1.0"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("v0.1.0 is already published as stable");
    expect(problems[0]).toContain("node scripts/update-release-package-versions.ts 0.1.1");
    expect(checkReleaseCandidate({ candidate: "0.1.0", publishedTags: ["v0.1.0"] })[0]).toContain(
      "0.1.1",
    );
  });

  it("refuses a base below the newest stable", () => {
    expect(
      checkReleaseCandidate({ candidate: "0.1.0-nightly.20261020.9", publishedTags: ["v0.2.0"] }),
    ).toEqual([expect.stringContaining("newest stable v0.2.0")]);
  });

  it("keeps the preview and nightly trains apart", () => {
    expect(
      checkReleaseCandidate({
        candidate: "0.1.0-nightly.20261013.3",
        publishedTags: ["v0.1.0-preview.20261014.7"],
      }),
    ).toEqual([]);
  });

  it("bumps the patch of the base", () => {
    expect(nextPatchVersion("0.1.9")).toBe("0.1.10");
    expect(nextPatchVersion("1.2.3-nightly.20261012.1")).toBe("1.2.4");
  });
});
