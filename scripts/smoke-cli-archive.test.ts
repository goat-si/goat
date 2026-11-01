import { describe, expect, it } from "vite-plus/test";
import { ownRuntimeManifest } from "@goat/shared/runtimeManifest";
import { checkCliRuntimeManifest } from "./smoke-cli-archive.ts";

const manifest = ownRuntimeManifest({ version: "1.2.3", commit: "abc", commitTime: 123 });
const json = JSON.stringify(manifest);

describe("CLI archive runtime smoke", () => {
  it("accepts a binary that agrees with its archive", () => {
    expect(checkCliRuntimeManifest(json, json, "1.2.3")).toEqual([]);
  });
  it.each([
    { version: "1.2.4" },
    { protocol: { ...manifest.protocol, ssh: { min: 999, max: 999 } } },
    { capabilities: [] },
    { commitTime: 124 },
    { commitTime: undefined },
    { commit: "def" },
  ])("rejects a binary with changed metadata: %j", (change) => {
    expect(
      checkCliRuntimeManifest(json, JSON.stringify({ ...manifest, ...change }), "1.2.3"),
    ).not.toEqual([]);
  });
  it("rejects a missing, malformed, wrong-schema or wrong-version manifest", () => {
    for (const source of ["", "not json", JSON.stringify({ ...manifest, schema: 2 })]) {
      expect(checkCliRuntimeManifest(source, json, "1.2.3")).not.toEqual([]);
      expect(checkCliRuntimeManifest(json, source, "1.2.3")).not.toEqual([]);
    }
    expect(checkCliRuntimeManifest(json, json, "1.2.4")).not.toEqual([]);
  });
});
