import { describe, expect, it } from "vite-plus/test";

import { checkReleaseVersions, RELEASE_MANIFESTS } from "./check-release-version.ts";

const all = (version: string) =>
  Object.fromEntries(RELEASE_MANIFESTS.map((file) => [file, version]));

describe("checkReleaseVersions", () => {
  it("accepts GOAT's first version and later ones", () => {
    expect(checkReleaseVersions(all("0.1.0"))).toEqual([]);
    expect(checkReleaseVersions(all("1.4.2"))).toEqual([]);
  });

  it("refuses manifests that disagree", () => {
    const versions = { ...all("0.1.0"), "apps/web/package.json": "0.0.45" };
    expect(checkReleaseVersions(versions)).toEqual([
      expect.stringContaining("release manifests disagree"),
    ]);
  });

  it("refuses an upstream version that slipped in through a merge", () => {
    expect(checkReleaseVersions(all("0.0.45"))).toEqual([expect.stringContaining("below 0.1.0")]);
  });

  it("refuses a prerelease suffix in the source manifests", () => {
    expect(checkReleaseVersions(all("0.1.0-beta.1"))).toEqual([
      expect.stringContaining("must be plain x.y.z"),
    ]);
    expect(checkReleaseVersions(all("0.01.0"))).toEqual([
      expect.stringContaining("must be plain x.y.z"),
    ]);
  });
});
