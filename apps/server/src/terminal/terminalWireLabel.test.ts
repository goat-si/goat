import { describe, expect, it } from "vite-plus/test";
import { truncateTerminalWireLabel } from "./terminalWireLabel.ts";

describe("truncateTerminalWireLabel", () => {
  it("preserves short labels including spaces", () => {
    expect(truncateTerminalWireLabel("Google Chrome")).toBe("Google Chrome");
  });

  it("avoids leaving a lone surrogate when truncating at 128 code units", () => {
    expect(truncateTerminalWireLabel("a".repeat(127) + "😀tail")).toBe("a".repeat(127));
  });
});
