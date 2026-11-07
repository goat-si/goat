import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  StyleSheet: { hairlineWidth: 1 },
}));

const { enrichedStyle } = await import("./enrichedMarkdownStyle");

const SYSTEM_FACE = "sans-serif";

const textStyle = {
  color: "#111111",
  strongColor: "#000000",
  mutedColor: "#666666",
  linkColor: "#0000ee",
  inlineCodeColor: "#333333",
  codeColor: "#333333",
  codeBackgroundColor: "#eeeeee",
  codeBlockBackgroundColor: "#eeeeee",
  fileTextColor: "#333333",
  quoteMarkerColor: "#cccccc",
  dividerColor: "#dddddd",
  fontSize: 16,
  lineHeight: 23,
  fontFamily: SYSTEM_FACE,
  headingFontFamily: SYSTEM_FACE,
  boldFontFamily: SYSTEM_FACE,
};

describe("enrichedStyle", () => {
  it("keeps strong text and table headers bold when the body and bold families are the same system face", () => {
    const style = enrichedStyle(textStyle, false);

    expect(style.strong?.fontWeight).toBe("bold");
    // Android draws a named header family at normal weight; without one it bolds the table family.
    expect(style.table?.headerFontFamily).toBeUndefined();
    // Headings inherit the library's bold default.
    expect(style.h1).not.toHaveProperty("fontWeight");
  });
});
