import { describe, expect, it } from "vite-plus/test";

import {
  apiKeyArgs,
  archiveProblems,
  exportOptionsPlist,
  parseOptions,
} from "./mobile-testflight.ts";

describe("parseOptions", () => {
  it("uploads production with a build number from the clock by default", () => {
    expect(parseOptions([], 1_792_000_000_000)).toEqual({
      variant: "production",
      buildNumber: "29866666",
      mode: "upload",
      dryRun: false,
    });
  });

  it("rejects build numbers App Store Connect would not accept", () => {
    expect(() => parseOptions(["--build-number", "0"])).toThrow("positive integer");
    expect(() => parseOptions(["--build-number", "1.2"])).toThrow("positive integer");
    expect(() => parseOptions(["--variant", "development"])).toThrow("production or preview");
  });
});

describe("apiKeyArgs", () => {
  it("uses Xcode's account when no key is configured", () => {
    expect(apiKeyArgs({})).toBeNull();
  });

  it("refuses a partly configured key instead of falling back to the account", () => {
    expect(() => apiKeyArgs({ ASC_KEY_ID: "ABC" })).toThrow("ASC_KEY_PATH");
  });
});

describe("exportOptionsPlist", () => {
  it("keeps the chosen build number", () => {
    const plist = exportOptionsPlist({ teamId: "U9ATA49N28", destination: "upload" });
    expect(plist).toContain("<key>manageAppVersionAndBuildNumber</key><false/>");
    expect(plist).toContain("<key>destination</key><string>upload</string>");
  });
});

describe("archiveProblems", () => {
  const expected = {
    appName: "GOAT",
    scheme: "goat",
    bundleId: "si.goat.mobile",
    buildNumber: "29866666",
  };
  const good = {
    bundles: [
      { name: "GOAT.app", bundleId: "si.goat.mobile", version: "29866666" },
      { name: "ExpoWidgetsTarget.appex", bundleId: "si.goat.mobile.widgets", version: "29866666" },
    ],
    embedded: { name: "GOAT", scheme: "goat", ios: { bundleIdentifier: "si.goat.mobile" } },
  };

  it("accepts an archive built for the variant", () => {
    expect(archiveProblems(good, expected)).toEqual([]);
  });

  it("rejects another identity in an extension or the embedded config", () => {
    expect(
      archiveProblems(
        {
          bundles: [
            good.bundles[0]!,
            { name: "Share.appex", bundleId: "com.t3tools.t3code.sharing", version: "29866666" },
          ],
          embedded: { ...good.embedded, ios: { bundleIdentifier: "si.goat.mobile.preview" } },
        },
        expected,
      ),
    ).toEqual([
      "Share.appex bundle id is com.t3tools.t3code.sharing",
      "embedded bundle id is si.goat.mobile.preview",
    ]);
  });

  it("rejects a stale build number and a missing embedded config", () => {
    expect(
      archiveProblems(
        {
          bundles: [good.bundles[0]!, { ...good.bundles[1]!, version: "1" }],
          embedded: null,
        },
        expected,
      ),
    ).toEqual(["ExpoWidgetsTarget.appex has build 1", "the app has no embedded Expo config"]);
  });
});
