export function terminalContentOriginY(
  mountHeight: number,
  padding: number,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
): number {
  if (!anchorBottom) return padding;
  const slack = mountHeight - padding * 2 - rows * cellHeight;
  return padding + Math.max(0, slack);
}

export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}
