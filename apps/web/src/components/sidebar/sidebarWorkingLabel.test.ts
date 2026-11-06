import { describe, expect, it } from "vite-plus/test";
import { sidebarWorkingLabel } from "./sidebarWorkingLabel";

describe("sidebarWorkingLabel", () => {
  it("shows goal before setup and keeps setup and working labels otherwise", () => {
    expect(sidebarWorkingLabel("preparing", true)).toBe("Goal");
    expect(sidebarWorkingLabel("preparing", false)).toBe("Setting up");
    expect(sidebarWorkingLabel("running", true)).toBe("Goal");
    expect(sidebarWorkingLabel("running", false)).toBe("Working");
  });
});
