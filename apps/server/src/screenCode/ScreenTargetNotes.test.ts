import { describe, expect, it } from "@effect/vitest";
import { browserSiteNote } from "@goat/provider-core/server/builtinSkills/browserSkillFiles";
import { screenTargetNote } from "./ScreenTargetNotes.ts";

describe("notes a bound target carries", () => {
  it("finds a tab's site note from its URL, IPv6 loopback included", () => {
    const loopback = browserSiteNote("localhost");
    expect(screenTargetNote("site", "http://[::1]:5173/app")).toBe(loopback);
    expect(screenTargetNote("site", "http://127.0.0.1:3000/")).toBe(loopback);
    expect(screenTargetNote("site", "https://shopping.naver.com/home")).toBe(
      browserSiteNote("naver.com"),
    );
    expect(screenTargetNote("site", "about:blank")).toBeUndefined();
    expect(screenTargetNote("site", "not a url")).toBeUndefined();
  });
});
