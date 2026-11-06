import { describe, expect, it } from "vite-plus/test";
import { sidebarWorkingLabel } from "./sidebarWorkingLabel";

describe("sidebarWorkingLabel", () => {
  it("shows setup before a goal and keeps goal and working labels otherwise", () => {
    expect(sidebarWorkingLabel("preparing", true)).toBe("Setting up");
    expect(sidebarWorkingLabel("running", true)).toBe("Goal");
    expect(sidebarWorkingLabel("running", false)).toBe("Working");
  });
});
