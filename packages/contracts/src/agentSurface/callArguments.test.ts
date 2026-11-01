import { describe, expect, it } from "vite-plus/test";
import { goatCallTarget } from "./callArguments.ts";

describe("goatCallTarget", () => {
  it("does not unwrap ACP envelopes on the authority path", () => {
    expect(
      goatCallTarget({
        server: "goat",
        tool: "goat_call",
        arguments: { path: "preview.click", args: { x: 1 } },
      }),
    ).toEqual({ path: "goat_call", args: { path: "preview.click", args: { x: 1 } } });
  });
});
