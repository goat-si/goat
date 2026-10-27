import { describe, expect, it } from "@effect/vitest";
import { resolveSeaBuildTarget } from "./sea-build-target.ts";

describe("SEA build targets", () => {
  it.each([undefined, "", "host", " host ", "linux-arm64"])(
    "uses native injection for Linux ARM64 target %s",
    (target) => {
      expect(resolveSeaBuildTarget({ target, platform: "linux", arch: "arm64" })).toEqual({
        target: target === "linux-arm64" ? target : undefined,
        injectLinuxArm64: true,
      });
    },
  );

  it.each([
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
  ])("rejects Linux ARM64 cross builds from %s-%s", (platform, arch) => {
    expect(() => resolveSeaBuildTarget({ target: "linux-arm64", platform, arch })).toThrow(
      /Linux ARM64 host/,
    );
  });

  it("keeps other cross targets and clears the host alias", () => {
    expect(
      resolveSeaBuildTarget({ target: " linux-x64 ", platform: "linux", arch: "arm64" }),
    ).toEqual({ target: "linux-x64", injectLinuxArm64: false });
    expect(resolveSeaBuildTarget({ target: "host", platform: "darwin", arch: "arm64" })).toEqual({
      target: undefined,
      injectLinuxArm64: false,
    });
  });
});
