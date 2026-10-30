import { describe, expect, it } from "vite-plus/test";
import { COMPACT_WORKSPACE_DOCK_HEIGHT } from "../workspace/workspace-tabs-state";
import { GOAT_BOT_COMPOSER_GAP, goatBotComposerBottomInsets } from "./goatBotComposerInsets";

/** Where KeyboardAvoidingView leaves the composer's bottom edge, measured from the screen bottom. */
function composerBottom(
  insets: ReturnType<typeof goatBotComposerBottomInsets>,
  keyboardHeight: number,
) {
  const lift = keyboardHeight > 0 ? Math.max(0, keyboardHeight + insets.keyboardVerticalOffset) : 0;
  return lift + insets.paddingBottom;
}

describe("GOAT Bot composer bottom insets", () => {
  it.each([0, 34])("rests above the floating tabs over a %s-point safe area", (bottomSafeArea) => {
    const insets = goatBotComposerBottomInsets({ bottomSafeArea, floatingTabs: true });
    expect(composerBottom(insets, 0)).toBe(
      bottomSafeArea + COMPACT_WORKSPACE_DOCK_HEIGHT + GOAT_BOT_COMPOSER_GAP,
    );
  });

  it.each([
    { bottomSafeArea: 34, floatingTabs: true },
    { bottomSafeArea: 34, floatingTabs: false },
    { bottomSafeArea: 0, floatingTabs: false },
  ])("sits one gap above an open keyboard: %j", (input) => {
    const insets = goatBotComposerBottomInsets(input);
    expect(composerBottom(insets, 336)).toBe(336 + GOAT_BOT_COMPOSER_GAP);
  });

  it("keeps the home indicator clear without floating tabs", () => {
    expect(
      composerBottom(goatBotComposerBottomInsets({ bottomSafeArea: 34, floatingTabs: false }), 0),
    ).toBe(34);
  });
});
