const PREVIEW_LIMIT = 300;

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

export function errorDetailsPreview(details: string) {
  const firstLine = details.split("\n", 1)[0] ?? "";
  return firstLine.slice(
    0,
    splitsSurrogatePair(firstLine, PREVIEW_LIMIT) ? PREVIEW_LIMIT - 1 : PREVIEW_LIMIT,
  );
}
