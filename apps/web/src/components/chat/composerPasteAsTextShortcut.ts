export function consumePasteAsTextShortcut(deadline: { current: number }): boolean {
  const armed = Date.now() <= deadline.current;
  deadline.current = 0;
  return armed;
}
