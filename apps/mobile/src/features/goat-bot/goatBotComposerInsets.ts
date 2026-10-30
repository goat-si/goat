import { COMPACT_WORKSPACE_DOCK_HEIGHT } from "../workspace/workspace-tabs-state";

/** Space between the composer and what lies under it: the keyboard, the safe area, or the tabs. */
export const GOAT_BOT_COMPOSER_GAP = 8;

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
