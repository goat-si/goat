export function buildWholeWordPattern(query: string, caseSensitive: boolean): string {
  return `(?${caseSensitive ? "" : "i"}-u)\\b${query}\\b`;
}

export function findWordRanges(line: string, word: string, caseSensitive: boolean) {
  return Array.from(line.matchAll(new RegExp(word, caseSensitive ? "g" : "gi")), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}
