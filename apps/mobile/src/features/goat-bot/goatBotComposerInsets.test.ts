import { describe, expect, it } from "vite-plus/test";
import { COMPACT_WORKSPACE_DOCK_HEIGHT } from "../workspace/workspace-tabs-state";
import {
  GOAT_BOT_COMPOSER_GAP,
  goatBotComposerBottomPadding,
  goatBotInputMaxHeight,
} from "./goatBotComposerInsets";

describe("GOAT Bot composer bottom padding", () => {
  it.each([0, 34])("rests above the floating tabs over a %s-point safe area", (bottomSafeArea) => {
    expect(goatBotComposerBottomPadding({ bottomSafeArea, floatingTabs: true }).closed).toBe(
      bottomSafeArea + COMPACT_WORKSPACE_DOCK_HEIGHT + GOAT_BOT_COMPOSER_GAP,
    );
  });

  it("keeps the home indicator clear without floating tabs", () => {
    expect(goatBotComposerBottomPadding({ bottomSafeArea: 34, floatingTabs: false }).closed).toBe(
      34,
    );
  });

  it.each([
    { bottomSafeArea: 34, floatingTabs: true },
    { bottomSafeArea: 34, floatingTabs: false },
  ])(
    "keeps only one gap above an open keyboard, so a short window fits the composer: %j",
    (input) => {
      expect(goatBotComposerBottomPadding(input).open).toBe(GOAT_BOT_COMPOSER_GAP);
    },
  );
});

describe("GOAT Bot message field height", () => {
  it.each([
    { windowHeight: 852, maxHeight: 160 },
    { windowHeight: 393, maxHeight: 98 },
    { windowHeight: 120, maxHeight: 44 },
  ])("leaves room for the header and keyboard in a %j window", ({ windowHeight, maxHeight }) => {
    expect(goatBotInputMaxHeight(windowHeight)).toBe(maxHeight);
  });
});
