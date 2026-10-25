import { describe, expect, it } from "vitest";

import {
  cuaDriverHostOptions,
  cuaDriverListingEnvironment,
  cuaDriverRelease,
  withCuaDriverPrivacyEnvironment,
} from "./cuaDriverRelease.ts";

describe("Cua Driver launch policy", () => {
  it.each([
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
    ["win32", "arm64"],
  ] as const)("downloads the pinned %s/%s archive from GOAT's fork (#1591)", (platform, arch) => {
    const release = cuaDriverRelease(platform, arch)!;
    expect(release.url).toBe(
      `https://github.com/goat-si/cua-driver/releases/download/cua-driver-rs-v${release.version}/${release.archiveName}`,
    );
    expect(release.requiredFiles).toContain(release.executable);
    expect(release.format).toBe(platform === "win32" ? "zip" : "tar.gz");
  });

  it("rejects unsupported targets instead of selecting another platform's archive", () => {
    expect(cuaDriverRelease("freebsd", "x64")).toBeNull();
    expect(cuaDriverRelease("linux", "ia32")).toBeNull();
  });

  it("prevents inherited and caller values from re-enabling screencapture (#1588)", () => {
    const name = "CUA_DRIVER_DISABLE_SCREENCAPTURE";
    expect(cuaDriverListingEnvironment({ [name]: "0", GOAT_SECRET: "private" })).toMatchObject({
      [name]: "1",
    });
    expect(cuaDriverListingEnvironment({ GOAT_SECRET: "private" })).not.toHaveProperty(
      "GOAT_SECRET",
    );
    const configuration = withCuaDriverPrivacyEnvironment({
      environment: [{ name: name.toLowerCase(), value: "0" }],
    });
    expect(
      configuration.environment.filter((variable) => variable.name.toUpperCase() === name),
    ).toEqual([{ name, value: "1" }]);
    // npm SDK 0.37.0 rejects this name during withOptions, before launching a daemon.
    for (const suppliedName of [name, name.toLowerCase()]) {
      const { environment } = cuaDriverHostOptions("/driver", "si.goat.dev", "/manifest", [
        { name: suppliedName, value: "0" },
      ]);
      expect(environment.some((variable) => variable.name.toUpperCase() === name)).toBe(false);
      expect(
        cuaDriverHostOptions(
          "/driver",
          "si.goat.dev",
          "/manifest",
          [],
          [suppliedName],
        ).environment.some((variable) => variable.name.toUpperCase() === name),
      ).toBe(false);
    }
  });
});
