import { COMPACT_WORKSPACE_DOCK_HEIGHT } from "../workspace/workspace-tabs-state";

/** Space between the composer and what lies under it: the keyboard, the safe area, or the tabs. */
export const GOAT_BOT_COMPOSER_GAP = 8;
const INPUT_MIN_HEIGHT = 44;
const INPUT_MAX_HEIGHT = 160;

/**
 * The composer's bottom padding with the keyboard closed and open. Closed, it rests above the
 * bottom safe area, or above the floating tabs that cover the screen. Open, the keyboard covers
 * both, so only one gap stays: a short window keeps its height for the composer itself.
 */
export function goatBotComposerBottomPadding(input: {
  readonly bottomSafeArea: number;
  readonly floatingTabs: boolean;
}) {
  const closed = input.floatingTabs
    ? COMPACT_WORKSPACE_DOCK_HEIGHT + input.bottomSafeArea + GOAT_BOT_COMPOSER_GAP
    : Math.max(GOAT_BOT_COMPOSER_GAP, input.bottomSafeArea);
  return { closed, open: GOAT_BOT_COMPOSER_GAP };
}

/**
 * How tall the message field may grow before it scrolls. A quarter of the window leaves the
 * header, the open keyboard and some conversation room in a landscape phone or a short window.
 */
export function goatBotInputMaxHeight(windowHeight: number) {
  return Math.max(INPUT_MIN_HEIGHT, Math.min(INPUT_MAX_HEIGHT, Math.floor(windowHeight / 4)));
}
