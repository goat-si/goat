function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function collapsedTimelineCommentMarkdown(body: string) {
  return body.slice(0, splitsSurrogatePair(body, 1200) ? 1199 : 1200);
}
