import { describe, expect, it } from "vite-plus/test";
import { goatCallTarget } from "./callArguments.ts";

describe("goatCallTarget", () => {
  it("unwraps a GOAT ACP call without mistaking other envelopes for one", () => {
    expect(
      goatCallTarget({
        server: "goat",
        tool: "goat_call",
        arguments: { path: "preview.click", args: { x: 1 } },
      }),
    ).toEqual({ path: "preview.click", args: { x: 1 } });
    expect(
      goatCallTarget({ server: "other", tool: "goat_call", arguments: { path: "preview.click" } })
        .path,
    ).toBe("goat_call");
    expect(
      goatCallTarget({
        server: "goat",
        tool: "goat_call",
        arguments: { path: "preview.click", name: "thread.read" },
      }),
    ).toEqual({});
  });
});
