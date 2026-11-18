import { describe, expect, it } from "vite-plus/test";
import { selectThemeEnvironment } from "./desktopHostEnvironment";

describe("theme environment", () => {
  it("prefers a primary environment", () => {
    expect(selectThemeEnvironment("main", "service", ["main", "service"])).toBe("main");
  });

  it("adopts the same-home service when the desktop primary is off", () => {
    expect(selectThemeEnvironment(null, "service", ["remote", "service"])).toBe("service");
  });

  it("has no fallback for a service absent from the catalog", () => {
    expect(selectThemeEnvironment(null, "service", ["remote"])).toBeNull();
    expect(selectThemeEnvironment(null, null, ["remote"])).toBeNull();
  });
});
