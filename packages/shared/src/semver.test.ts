import { describe, expect, it } from "vite-plus/test";

import {
  compareRuntimeBuilds,
  compareSemverVersions,
  normalizeSemverVersion,
  parseSemver,
  satisfiesSemverRange,
} from "./semver.ts";

describe("semver helpers", () => {
  it("matches supported range groups", () => {
    const range = "^22.16 || ^23.11 || >=24.10";

    expect(satisfiesSemverRange("22.16.0", range)).toBe(true);
    expect(satisfiesSemverRange("23.11.1", range)).toBe(true);
    expect(satisfiesSemverRange("24.10.0", range)).toBe(true);
    expect(satisfiesSemverRange("22.15.9", range)).toBe(false);
    expect(satisfiesSemverRange("23.10.9", range)).toBe(false);
    expect(satisfiesSemverRange("24.9.9", range)).toBe(false);
  });

  it("normalizes and parses shorthand major-only versions", () => {
    expect(normalizeSemverVersion("20")).toBe("20.0.0");
    expect(normalizeSemverVersion("v18")).toBe("v18.0.0");
    expect(normalizeSemverVersion("20-rc.1")).toBe("20.0.0-rc.1");
    expect(parseSemver("20")).toEqual({ major: 20, minor: 0, patch: 0, prerelease: [] });
  });

  it("compares shorthand versions numerically instead of lexically", () => {
    expect(compareSemverVersions("20", "9")).toBeGreaterThan(0);
    expect(compareSemverVersions("18", "18.0.0")).toBe(0);
  });

  it("compares prerelease versions before stable versions", () => {
    expect(compareSemverVersions("2.1.111-beta.1", "2.1.111")).toBeLessThan(0);
  });

  it.each([
    ["1.2.3-preview-z", "1.2.3-preview.20260911.4", 1],
    ["1.2.3-preview.9", "1.2.3-preview.10", -1],
    ["1.2.3-preview.9", "1.2.3-preview.alpha", -1],
    ["1.2.3-preview.Z", "1.2.3-preview.a", -1],
    ["1.2.3-preview.99999999999999999999", "1.2.3-preview.99999999999999999998", 1],
    ["1.2.3-preview-z+build.1", "1.2.3-preview-z+build.2", 0],
    ["1.2.3+build.1", "1.2.3", 0],
  ])("compares complete SemVer precedence: %s versus %s", (left, right, order) => {
    expect(Math.sign(compareSemverVersions(left, right))).toBe(order);
    expect(Math.sign(compareSemverVersions(right, left))).toBe(order === 0 ? 0 : -order);
  });

  it("preserves the full prerelease and build suffix while normalizing", () => {
    expect(normalizeSemverVersion("20-preview-z+build.1")).toBe("20.0.0-preview-z+build.1");
    expect(parseSemver("1.2.3-preview-z+build.1")?.prerelease).toEqual(["preview-z"]);
    expect(parseSemver("1.2.3-preview.01")).toBeNull();
  });

  describe("compareRuntimeBuilds", () => {
    const older = 1_791_862_399;
    const newer = 1_791_866_417;
    it.each([
      // Dev builds order by commit, never by sha (#128): "e…" sorts above "8…".
      [
        { version: "0.1.0-dev.e17501807", commitTime: older },
        { version: "0.1.0-dev.84b52e284", commitTime: newer },
        -1,
      ],
      // A newer dev build ranks above an older nightly, whatever the train names say.
      [
        { version: "0.1.0-dev.84b52e284", commitTime: newer },
        { version: "0.1.0-nightly.20261012.2", commitTime: older },
        1,
      ],
      [
        { version: "0.1.0-nightly.20261012.2", commitTime: older },
        { version: "0.1.0-dev.84b52e284", commitTime: newer },
        -1,
      ],
      // `<base>-dev.<commit time>.g<sha>` carries its own order. The sha sorts the
      // other way ("gfff…" above "g001…") and must not win.
      [
        { version: "0.1.0-dev.1792000000.gfff881545" },
        { version: "0.1.0-dev.1792000100.g001234567" },
        -1,
      ],
      // Numbered builds of one train keep SemVer order, stamped or not.
      [{ version: "0.1.0-nightly.20261012.10" }, { version: "0.1.0-nightly.20261012.2" }, 1],
      [
        { version: "0.1.0-nightly.20261013.0", commitTime: older },
        { version: "0.1.0-nightly.20261012.2", commitTime: newer },
        1,
      ],
      // A different core is a release decision; a later hotfix commit never outranks it.
      [{ version: "0.2.0", commitTime: older }, { version: "0.1.1", commitTime: newer }, 1],
      [{ version: "0.1.0" }, { version: "0.1.0" }, 0],
      [
        { version: "0.1.0-dev.aaa", commitTime: newer },
        { version: "0.1.0-nightly.20261012.2", commitTime: newer },
        0,
      ],
      // A sha can be all digits; it still orders by commit, never as a number.
      [
        { version: "0.1.0-dev.987654321", commitTime: older },
        { version: "0.1.0-dev.123456789", commitTime: newer },
        -1,
      ],
    ] as const)("orders %j against %j", (left, right, order) => {
      expect(Math.sign(compareRuntimeBuilds(left, right) ?? Number.NaN)).toBe(order);
      expect(Math.sign(compareRuntimeBuilds(right, left) ?? Number.NaN)).toBe(
        order === 0 ? 0 : -order,
      );
    });

    it.each([
      [{ version: "0.1.0-dev.e17501807" }, { version: "0.1.0-dev.84b52e284", commitTime: newer }],
      [{ version: "0.1.0-dev.e17501807", commitTime: older }, { version: "0.1.0-dev.84b52e284" }],
      [{ version: "0.1.0-nightly.20261012.2" }, { version: "0.1.0-dev.84b52e284" }],
      [{ version: "0.1.0" }, { version: "0.1.0-dev.84b52e284" }],
      [{ version: "0.1.0-dev.123456789" }, { version: "0.1.0-dev.987654321" }],
      [
        { version: "not-a-version", commitTime: older },
        { version: "0.1.0", commitTime: newer },
      ],
    ] as const)("has no order for %j against %j without both commit times", (left, right) => {
      expect(compareRuntimeBuilds(left, right)).toBeUndefined();
      expect(compareRuntimeBuilds(right, left)).toBeUndefined();
    });
  });

  it("supports comparison comparators", () => {
    expect(satisfiesSemverRange("24.9.0", ">=24.0 <24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">=24.0 <24.10")).toBe(false);
  });

  it("honors caret range upper bounds for zero-major versions", () => {
    expect(satisfiesSemverRange("0.2.3", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.5.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesSemverRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("keeps the range checker stringifiable and executable as plain JavaScript", () => {
    const source = satisfiesSemverRange.toString();
    const recreated = Function(`return (${source});`)() as typeof satisfiesSemverRange;

    expect(source).toContain("function satisfiesSemverRange");
    expect(source).not.toContain(": string");
    expect(source).not.toContain(": boolean");
    expect(recreated("24.10.0", ">=24.10")).toBe(true);
    expect(recreated("24.9.9", ">=24.10")).toBe(false);
  });
});
