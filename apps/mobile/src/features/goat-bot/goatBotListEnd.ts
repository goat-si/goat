/** The list's bottom content padding, below its footer (GoatBotScreen's contentContainerStyle). */
export const GOAT_BOT_LIST_PADDING = 16;
/** The part of the progress line that must show before its motion may run. */
const MIN_VISIBLE_FRACTION = 0.5;

/**
 * Whether at least half of the progress line shows. The line is the list's footer, so its top is the
 * content height less the bottom padding and its own measured height. Unmeasured counts as hidden.
 */
export function goatBotFooterInView(input: {
  readonly offsetY: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  readonly footerHeight: number;
}): boolean {
  if (input.footerHeight <= 0 || input.viewportHeight <= 0) return false;
  const footerTop = input.contentHeight - GOAT_BOT_LIST_PADDING - input.footerHeight;
  const visible =
    Math.min(input.offsetY + input.viewportHeight, footerTop + input.footerHeight) -
    Math.max(input.offsetY, footerTop);
  return visible >= input.footerHeight * MIN_VISIBLE_FRACTION;
}
