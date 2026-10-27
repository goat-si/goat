import { describe, expect, it } from "vite-plus/test";

import {
  OPEN_CODEX_PINNED_VERSION,
  parseOpenCodexVersion,
  resolveOpenCodexRelease,
  supportedOpenCodexVersion,
  type OpenCodexReleaseCatalog,
} from "./opencodexRelease.ts";

const row = (version: string, target: string) => ({
  version,
  target,
  url: `https://example.invalid/ocx-${version}-${target}.tar.gz`,
  sha256: "0".repeat(64),
  archiveBytes: 1,
  publishedAt: "2026-10-24T00:00:00Z",
  layout: { executable: "ocx", gui: "gui/dist/index.html", keyring: "keyring" },
  remoteLinkWindows: false,
});
const catalog: OpenCodexReleaseCatalog = {
  "2.90.0": { "linux-x64": row("2.90.0", "bun-linux-x64") },
  "2.92.0": {
    "linux-x64": row("2.92.0", "bun-linux-x64"),
    "darwin-arm64": row("2.92.0", "bun-darwin-arm64"),
  },
};

describe("OpenCodex release selection", () => {
  it("keeps a supported Child version when Home has another version", () => {
    // The floor is Remote Link's, not the Home's release: 2.70 stays even beside a 2.92 Home.
    expect(supportedOpenCodexVersion("2.70.0")).toBe(true);
    expect(supportedOpenCodexVersion("2.66.0")).toBe(true);
    expect(supportedOpenCodexVersion("2.65.9")).toBe(false);
    expect(supportedOpenCodexVersion("not-a-version")).toBe(false);
  });

  it.each([
    { platform: "win32", arch: "arm64", version: undefined },
    { platform: "linux", arch: "ia32", version: undefined },
    { platform: "linux", arch: "x64", version: "2.91.0" },
  ])("rejects targets without a published standalone asset: $platform-$arch $version", (input) => {
    expect(resolveOpenCodexRelease(input.platform, input.arch, input.version, catalog)).toBe(
      undefined,
    );
  });

  it("selects the compiled release rather than a Home version", () => {
    expect(resolveOpenCodexRelease("darwin", "arm64", undefined, catalog)?.target).toBe(
      "bun-darwin-arm64",
    );
    // Rollback still finds a retained older row when it is asked for by version.
    expect(resolveOpenCodexRelease("linux", "x64", "2.90.0", catalog)?.version).toBe("2.90.0");
    // Every published POSIX target has a reviewed pin for the compiled default.
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
    ] as const)
      expect(resolveOpenCodexRelease(platform, arch)?.version).toBe(OPEN_CODEX_PINNED_VERSION);
    expect(resolveOpenCodexRelease("win32", "x64")).toBe(undefined);
    // The standalone executable's own answer, as v2.92.0 prints it.
    expect(parseOpenCodexVersion("opencodex 2.92.0\n")).toBe("2.92.0");
  });
});
