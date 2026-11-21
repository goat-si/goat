export function terminalFontOptions(
  family: string,
  size: number,
): { family?: string; size: number } {
  const trimmed = family.trim();
  return trimmed.length > 0 ? { family: trimmed, size } : { size };
}
