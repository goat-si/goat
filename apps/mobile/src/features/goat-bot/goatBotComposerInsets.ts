import { COMPACT_WORKSPACE_DOCK_HEIGHT } from "../workspace/workspace-tabs-state";

/** Space between the composer and what lies under it: the keyboard, the safe area, or the tabs. */
export const GOAT_BOT_COMPOSER_GAP = 8;

/**
 * The composer rests above the bottom safe area, or above the floating tabs that cover the
 * screen. KeyboardAvoidingView lifts by the keyboard height plus its vertical offset, so the
 * offset hands back that resting padding and the open composer sits one gap above the keyboard.
 */
export function goatBotComposerBottomInsets(input: {
  readonly bottomSafeArea: number;
  readonly floatingTabs: boolean;
}) {
  const paddingBottom = input.floatingTabs
    ? COMPACT_WORKSPACE_DOCK_HEIGHT + input.bottomSafeArea + GOAT_BOT_COMPOSER_GAP
    : Math.max(GOAT_BOT_COMPOSER_GAP, input.bottomSafeArea);
  return { paddingBottom, keyboardVerticalOffset: GOAT_BOT_COMPOSER_GAP - paddingBottom };
}
