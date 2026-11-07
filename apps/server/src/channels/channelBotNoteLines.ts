/**
 * The lines of GOAT Bot's notes file and which of them still apply. A correction is a later line
 * ending in ` (replaces: "<old text>")`; it replaces the nearest earlier note still in force with
 * that text, so the file stays append-only and the newest note wins for every reader.
 *
 * @module channelBotNoteLines
 */

export const NOTES_HEADER =
  "# GOAT Bot notes\n\nStanding notes people asked GOAT Bot to keep, newest last. Edit or delete lines freely.\n\n";

export interface ChannelBotNoteLine {
  /** Position among the lines parsed, oldest first. */
  readonly index: number;
  readonly date: string | null;
  readonly text: string;
  readonly raw: string;
  readonly replaces?: string;
  readonly replacedBy?: number;
}

// The writer removes only whitespace from the input id, so the id runs to its closing parenthesis.
const SOURCED = /^- (\d{4}-\d{2}-\d{2}): (.+) \(asked in (\S+)\)$/u;
const DATED = /^- (\d{4}-\d{2}-\d{2}): (.+)$/u;
const MARKER = " (replaces: ";

export const collapseNoteText = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The marker a correction line ends with; JSON keeps quotes and parentheses in the text exact. */
export const replacesMarker = (text: string) => MARKER + JSON.stringify(text) + ")";

const jsonString = (text: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A marker counts only at the end of the line, right after the line's own "(asked in <id>)", and
 * only when the rest of the line is one JSON string. A marker typed into a note is followed by
 * the real source, so it never reaches the end of the line.
 */
const parseLine = (raw: string, index: number): ChannelBotNoteLine => {
  if (raw.endsWith(")")) {
    for (let at = raw.indexOf(MARKER); at !== -1; at = raw.indexOf(MARKER, at + 1)) {
      const replaces = jsonString(raw.slice(at + MARKER.length, -1));
      const head = replaces === undefined ? null : SOURCED.exec(raw.slice(0, at));
      const date = head?.[1];
      const text = head?.[2];
      if (replaces !== undefined && date !== undefined && text !== undefined) {
        return { index, date, text, raw, replaces };
      }
    }
  }
  const plain = SOURCED.exec(raw) ?? DATED.exec(raw);
  const date = plain?.[1];
  const text = plain?.[2];
  return date !== undefined && text !== undefined
    ? { index, date, text, raw }
    : { index, date: null, text: raw.replace(/^[-*]\s+/u, ""), raw };
};

const markReplaced = (lines: ReadonlyArray<ChannelBotNoteLine>) => {
  const replacedBy = new Map<number, number>();
  for (const line of lines) {
    if (line.replaces === undefined) continue;
    const wanted = collapseNoteText(line.replaces);
    for (let earlier = line.index - 1; earlier >= 0; earlier--) {
      const candidate = lines[earlier];
      if (candidate === undefined || replacedBy.has(earlier)) continue;
      if (collapseNoteText(candidate.text) !== wanted) continue;
      replacedBy.set(earlier, line.index);
      break;
    }
  }
  return lines.map((line) => {
    const by = replacedBy.get(line.index);
    return by === undefined ? line : { ...line, replacedBy: by };
  });
};

/** Every line of a notes file, oldest first, without the header, blank lines or headings. */
export const parseChannelBotNoteLines = (text: string): ReadonlyArray<ChannelBotNoteLine> => {
  const normal = text.replaceAll("\r\n", "\n");
  const body = normal.startsWith(NOTES_HEADER) ? normal.slice(NOTES_HEADER.length) : normal;
  const lines: Array<ChannelBotNoteLine> = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    lines.push(parseLine(line, lines.length));
  }
  return markReplaced(lines);
};

/** The newest `chars` of a text, starting at a whole line. */
export const notesTail = (text: string, chars: number) => {
  if (text.length <= chars) return text;
  const part = text.slice(-chars - 1);
  return part.slice(part.indexOf("\n") + 1);
};

/**
 * The note a correction names: a whole dated line counts by its text. The newest note in force
 * with that text wins; a note already replaced leads to the note that replaced it, so corrections
 * saved one after another each replace the latest.
 */
export const noteNamedBy = (lines: ReadonlyArray<ChannelBotNoteLine>, named: string) => {
  const parsed = parseLine(collapseNoteText(named), 0);
  const wanted = collapseNoteText(parsed.date === null ? named : parsed.text);
  const matches = (line: ChannelBotNoteLine) => collapseNoteText(line.text) === wanted;
  let found =
    lines.findLast((line) => line.replacedBy === undefined && matches(line)) ??
    lines.findLast(matches);
  while (found?.replacedBy !== undefined) found = lines[found.replacedBy];
  return found;
};
