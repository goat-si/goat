export function* markdownLinksStartingBefore(text: string, pattern: RegExp, limit: number) {
  const matchAt = new RegExp(pattern.source, "y");
  let previousEnd = 0;
  // The extra character lets an image marker at the boundary see its opening bracket.
  for (const opening of text.slice(0, limit + 1).matchAll(/(?=!?\[)/g)) {
    if (opening.index >= limit) break;
    if (opening.index < previousEnd) continue;
    matchAt.lastIndex = opening.index;
    const match = matchAt.exec(text);
    if (!match) continue;
    previousEnd = matchAt.lastIndex;
    yield match;
  }
}
