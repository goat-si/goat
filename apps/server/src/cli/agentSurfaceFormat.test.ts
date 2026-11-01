import { describe, expect, it } from "@effect/vitest";

import { formatDescribe } from "./agentSurfaceFormat.ts";

describe("goat describe output", () => {
  it("prints a path described at names detail without fields it was not given", () => {
    const text = formatDescribe({
      depth: "path",
      entry: { path: "html.render", name: "goat_html_render", summary: "Render HTML" },
    });
    expect(text).toContain("html.render");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("Input schema");
  });
});
