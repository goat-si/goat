import { describe, expect, it } from "vite-plus/test";

import { neutralizeBuildRoot } from "./sea-build-path.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("neutralizeBuildRoot", () => {
  it("replaces every occurrence with a same-length neutral path", () => {
    const root = "/Users/someone/actions-runner/_work/goat/goat";
    const input = new TextEncoder().encode(`\0${root}/apps/server/dist-exe/bin.mjs\0x${root}/y`);
    const output = neutralizeBuildRoot(input, `${root}/`);
    expect(output.length).toBe(input.length);
    expect(text(output)).not.toContain(root);
    expect(text(output)).toContain("/goat-build___");
    expect(text(output)).toContain("/apps/server/dist-exe/bin.mjs");
  });

  it("leaves bytes without the root untouched", () => {
    const input = new TextEncoder().encode("/Users/admin/build/ws/deps/x.rs");
    expect(neutralizeBuildRoot(input, "/Users/someone/goat")).toEqual(input);
  });
});
