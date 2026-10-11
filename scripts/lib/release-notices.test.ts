import { describe, expect, it } from "vite-plus/test";

import { renderThirdPartyNotices } from "./release-notices.ts";

describe("renderThirdPartyNotices", () => {
  it("lists packages by name with license, source and notice text", () => {
    const text = renderThirdPartyNotices({
      schemaVersion: 1,
      entries: [
        {
          bundles: ["web"],
          kind: "package",
          license: "MIT",
          name: "zod",
          noticeText: "Copyright zod authors",
          sourceUrl: null,
          version: "3.0.0",
        },
        {
          bundles: ["server"],
          kind: "package",
          license: "Apache-2.0",
          name: "effect",
          noticeText: "Copyright Effectful\n```fence```",
          sourceUrl: "https://github.com/Effect-TS/effect",
          version: "4.0.0",
        },
      ],
    });
    expect(text.indexOf("## effect 4.0.0")).toBeLessThan(text.indexOf("## zod 3.0.0"));
    expect(text).toContain("License: Apache-2.0\n\nSource: https://github.com/Effect-TS/effect");
    expect(text).toContain("License: MIT\n\n```text\nCopyright zod authors\n```");
    // A notice cannot close the fence it is rendered in.
    expect(text.match(/^```$/gm)).toHaveLength(2);
  });
});
