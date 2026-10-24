import { NOTE_PREVIEW_MAX_LENGTH, NOTE_TITLE_MAX_LENGTH } from "@goat/contracts";

const displayText = (text: string, maxLength: number) => {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  return `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
};
const displayTitle = (title: string) => displayText(title, NOTE_TITLE_MAX_LENGTH);
const stripMarkers = (line: string) =>
  line
    .trim()
    .replace(/^(?:(?:#{1,6}|[-*+>]|\d+\.)\s+|\[[ xX]\]\s*)+/u, "")
    .trim();
export const bodySummary = (body: string, fallback: string) => {
  const lines = body.split(/\r?\n/u);
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/mu.exec(body);
  const titleIndex = heading
    ? body.slice(0, heading.index).split("\n").length - 1
    : lines.findIndex((line) => line.trim().length > 0);
  const firstLine = lines[titleIndex];
  const title = heading?.[1] ?? (firstLine === undefined ? fallback : stripMarkers(firstLine));
  const preview = lines
    .filter((line, index) => index !== titleIndex && !/^\s*(?:`{3,}|~{3,})/u.test(line))
    .map(stripMarkers)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    title: displayTitle(title || fallback),
    preview: displayText(preview, NOTE_PREVIEW_MAX_LENGTH),
  };
};
