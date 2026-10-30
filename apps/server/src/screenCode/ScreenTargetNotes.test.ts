import { describe, expect, it } from "@effect/vitest";
import { computerUseAppNote } from "@goat/provider-core/server/builtinSkills/computerUseSkillFiles";
import * as HostProcess from "@goat/shared/HostProcess";
import { screenTargetNote } from "./ScreenTargetNotes.ts";

describe("notes a bound target carries", () => {
  it("keeps app guidance and does not inject static site notes", () => {
    expect(screenTargetNote("app", "Finder")).toBe(computerUseAppNote(HostProcess.Platform.defaultValue(), "Finder"));
    expect(screenTargetNote("site", "https://www.naver.com")).toBeUndefined();
    expect(screenTargetNote("app", "")).toBeUndefined();
  });
});
