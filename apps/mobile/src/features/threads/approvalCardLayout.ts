// p-4 padding top and bottom plus the two gap-3 gaps around the request (spacing unit 3.5pt).
const APPROVAL_CARD_CHROME = 2 * 14 + 2 * 10.5;
// About two lines of request text: less than this and the request is unreadable beside the actions.
const MIN_REQUEST_HEIGHT = 44;

/**
 * Whether the approval card can keep its title and actions pinned around a scrolling request.
 * When the height cap is too small for that, the whole card scrolls so every action stays reachable.
 */
export function approvalActionsFitPinned(input: {
  readonly headerHeight: number;
  readonly actionsHeight: number;
  readonly cardHeight: number;
}): boolean {
  if (input.headerHeight <= 0 || input.actionsHeight <= 0 || input.cardHeight <= 0) return true;
  return (
    input.headerHeight + input.actionsHeight + APPROVAL_CARD_CHROME + MIN_REQUEST_HEIGHT <=
    input.cardHeight
  );
}
