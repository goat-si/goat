import { describe, expect, it } from "vite-plus/test";
import { GOAT_BOT_BUBBLE_COLORS, goatBotBubbleLayout } from "./goatBotBubbleStyle";

describe("GOAT Bot bubble layout", () => {
  it("separates groups and shows a tail only on their final bubble", () => {
    expect(goatBotBubbleLayout("first")).toEqual({ marginTop: 12, tail: false });
    expect(goatBotBubbleLayout("middle")).toEqual({ marginTop: 4, tail: false });
    expect(goatBotBubbleLayout("last")).toEqual({ marginTop: 4, tail: true });
    expect(goatBotBubbleLayout("single")).toEqual({ marginTop: 12, tail: true });
  });

  it("uses Messages colors in both appearances", () => {
    expect(GOAT_BOT_BUBBLE_COLORS.light).toEqual({
      out: "#1466D0",
      outText: "#FFFFFF",
      in: "#E9E9EB",
      inText: "#000000",
    });
    expect(GOAT_BOT_BUBBLE_COLORS.dark).toEqual({
      out: "#2B66C6",
      outText: "#FFFFFF",
      in: "#3A3A3C",
      inText: "#FFFFFF",
    });
  });
});
