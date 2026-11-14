export function orderedListGutterStyle(
  itemValues: ReadonlyArray<unknown>,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  let number = Number.isNaN(parsedStart) ? 1 : parsedStart;
  let markerWidth = String(number).length;
  for (const value of itemValues) {
    const written = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isNaN(written)) number = written;
    markerWidth = Math.max(markerWidth, String(number).length);
    number += 1;
  }
  if (markerWidth <= 1) return undefined;
  return { "--list-gutter": `${markerWidth + 2}ch` };
}
