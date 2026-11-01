import { describe, expect, it } from "vite-plus/test";
import {
  classifyDesktopUpdateInstallation,
  getDesktopUpdateInstallationMessage,
} from "./updateInstallation.ts";

const writableMac = {
  platform: "darwin",
  appBundlePath: "/Applications/GOAT.app",
  bundleWritable: true,
  parentWritable: true,
  readOnlyVolume: false,
};

describe("classifyDesktopUpdateInstallation", () => {
  it.each([
    [{}, null],
    [{ appBundlePath: "/Volumes/External/GOAT.app" }, null],
    [
      { appBundlePath: "/private/var/AppTranslocation/id/d/GOAT.app", readOnlyVolume: true },
      "translocated",
    ],
    [{ readOnlyVolume: true, bundleWritable: false, parentWritable: false }, "read-only-volume"],
    [{ bundleWritable: false }, "needs-admin"],
    [{ parentWritable: false }, "needs-admin"],
    [{ bundleWritable: false, parentWritable: false }, "needs-admin"],
    [{ platform: "linux", readOnlyVolume: true, bundleWritable: false }, null],
    [{ platform: "win32", parentWritable: false }, null],
  ] as const)("classifies %j as %s", (overrides, expected) => {
    expect(classifyDesktopUpdateInstallation({ ...writableMac, ...overrides })).toBe(expected);
  });

  it.each(["translocated", "read-only-volume", "needs-admin"] as const)(
    "explains recovery and independent server updates for %s",
    (reason) => {
      const message = getDesktopUpdateInstallationMessage(reason);
      expect(message).toContain(reason === "needs-admin" ? "administrator" : "Applications");
      expect(message).toContain("including this Mac's SSH runtime");
      expect(message).toContain("still update on their own");
    },
  );
});
