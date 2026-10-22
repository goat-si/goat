export interface NoteCheckbox {
  readonly offset: number;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly checked: boolean;
  readonly label: string;
}

export function toggleNoteCheckbox(
  markdown: string,
  offset: number,
  // Only the display parser can approve editable markers; raw scanning also matches code/HTML.
  parsed: ReadonlyArray<NoteCheckbox> = [],
): string {
  const checkbox = parsed.find((box) => box.offset === offset);
  if (
    !checkbox ||
    markdown[offset - 1] !== "[" ||
    markdown[offset + 1] !== "]" ||
    !/[ xX]/.test(markdown[offset] ?? "")
  )
    return markdown;
  return markdown.slice(0, offset) + (checkbox.checked ? " " : "x") + markdown.slice(offset + 1);
}
