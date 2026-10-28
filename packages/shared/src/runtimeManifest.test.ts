import { describe, expect, it } from "vite-plus/test";

import { cliArchiveFileName } from "./cliRelease.ts";
import {
  decodeRuntimeManifest,
  ownRuntimeManifest,
  releaseRuntimeManifest,
  runtimeManifestVerdict,
  type RuntimeManifest,
} from "./runtimeManifest.ts";

const client = { ssh: { min: 5, max: 5 }, orchestration: { min: 7, max: 7 } };
const manifest = (overrides: Partial<RuntimeManifest> = {}): RuntimeManifest => ({
  schema: 1,
  version: "1.2.3",
  protocol: { ssh: { min: 5, max: 5 }, orchestration: { min: 6, max: 7 } },
  capabilities: ["memory-scopes"],
  ...overrides,
});

describe("runtime manifest", () => {
  it("accepts a runtime whose served ranges contain the client's protocols", () => {
    expect(runtimeManifestVerdict(manifest(), client)).toBe("compatible");
  });

  it("names which side is too old", () => {
    const older = manifest({
      protocol: { ssh: { min: 5, max: 5 }, orchestration: { min: 5, max: 6 } },
    });
    const newer = manifest({
      protocol: { ssh: { min: 6, max: 6 }, orchestration: { min: 7, max: 7 } },
    });
    expect(runtimeManifestVerdict(older, client)).toBe("update-required");
    expect(runtimeManifestVerdict(newer, client)).toBe("client-too-old");
  });

  it("refuses a compatible runtime without a required capability", () => {
    expect(runtimeManifestVerdict(manifest({ capabilities: [] }), client)).toBe(
      "missing-capability",
    );
  });

  it("refuses malformed ranges", () => {
    const inverted = manifest({
      protocol: { ssh: { min: 6, max: 5 }, orchestration: { min: 7, max: 7 } },
    });
    expect(runtimeManifestVerdict(inverted, client)).toBe("invalid");
  });

  it("decodes only schema 1", () => {
    expect(decodeRuntimeManifest(JSON.stringify(manifest()))).toEqual(manifest());
    expect(decodeRuntimeManifest(JSON.stringify({ ...manifest(), schema: 2 }))).toBeUndefined();
    expect(decodeRuntimeManifest("not json")).toBeUndefined();
  });

  it("lists every checksummed platform archive in the release asset", () => {
    const own = ownRuntimeManifest({ version: "1.2.3", commitTime: 10 });
    const arm = cliArchiveFileName("1.2.3", "linux-arm64");
    const release = releaseRuntimeManifest(
      own,
      new Map([
        [arm, "a".repeat(64)],
        ["goat-1.2.3-arm64.dmg", "b".repeat(64)],
      ]),
    );
    expect(release.platforms).toEqual({ "linux-arm64": { asset: arm, sha256: "a".repeat(64) } });
    expect(release.commitTime).toBe(10);
    expect(() => releaseRuntimeManifest(own, new Map())).toThrow(/no runtime archive/);
  });
});
