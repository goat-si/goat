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
  /** The channel input named by "(asked in <id>)", for a line reception saved. */
  readonly sourceInputId?: string;
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
      const sourceInputId = head?.[3];
      if (replaces !== undefined && date !== undefined && text !== undefined) {
        return { index, date, text, raw, replaces, ...(sourceInputId ? { sourceInputId } : {}) };
      }
    }
  }
  const sourced = SOURCED.exec(raw);
  const plain = sourced ?? DATED.exec(raw);
  const date = plain?.[1];
  const text = plain?.[2];
  const sourceInputId = sourced?.[3];
  return date !== undefined && text !== undefined
    ? { index, date, text, raw, ...(sourceInputId ? { sourceInputId } : {}) }
    : { index, date: null, text: raw.replace(/^[-*]\s+/u, ""), raw };
};

// Earlier notes still in force, by text and newest last, so each correction finds its note in one step.
const markReplaced = (lines: ReadonlyArray<ChannelBotNoteLine>) => {
  const replacedBy = new Map<number, number>();
  const inForce = new Map<string, Array<number>>();
  for (const line of lines) {
    if (line.replaces !== undefined) {
      const earlier = inForce.get(collapseNoteText(line.replaces))?.pop();
      if (earlier !== undefined) replacedBy.set(earlier, line.index);
    }
    const text = collapseNoteText(line.text);
    const same = inForce.get(text);
    if (same === undefined) inForce.set(text, [line.index]);
    else same.push(line.index);
  }
  return lines.map((line) => {
    const by = replacedBy.get(line.index);
    return by === undefined ? line : { ...line, replacedBy: by };
  });
};

/** A note line without the replaces marker the parser counts, or the line itself when it has none. */
export const withoutReplacesMarker = (raw: string) => {
  if (!raw.endsWith(")")) return raw;
  for (let at = raw.indexOf(MARKER); at !== -1; at = raw.indexOf(MARKER, at + 1)) {
    const replaces = jsonString(raw.slice(at + MARKER.length, -1));
    if (replaces !== undefined && SOURCED.test(raw.slice(0, at))) return raw.slice(0, at);
  }
  return raw;
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

/** The one note words name, or how many notes they could mean when that is not exactly one. */
export type NamedNote =
  | { readonly line: ChannelBotNoteLine; readonly alike?: undefined }
  | { readonly line?: undefined; readonly alike: number };

// Words name a note only when exactly one candidate reads them, so nothing acts on a guess.
const onlyOne = (candidates: ReadonlyArray<ChannelBotNoteLine>): NamedNote => {
  const [line, ...others] = candidates;
  return line !== undefined && others.length === 0 ? { line } : { alike: candidates.length };
};

/** The current note whose text is `words`, spacing collapsed. Every change or forget starts here. */
export const currentNoteNamedBy = (lines: ReadonlyArray<ChannelBotNoteLine>, words: string) => {
  const wanted = collapseNoteText(words);
  return onlyOne(
    lines.filter((line) => line.replacedBy === undefined && collapseNoteText(line.text) === wanted),
  );
};

/**
 * The note a correction names: a whole dated line counts by its text. Words no current note reads
 * but a replaced one does lead to the note that replaced it, so corrections saved one after another
 * each replace the latest; there too they name a note only when they lead to exactly one.
 */
export const noteNamedBy = (lines: ReadonlyArray<ChannelBotNoteLine>, named: string): NamedNote => {
  const parsed = parseLine(collapseNoteText(named), 0);
  const words = parsed.date === null ? named : parsed.text;
  const current = currentNoteNamedBy(lines, words);
  if (current.line !== undefined || current.alike > 1) return current;
  const wanted = collapseNoteText(words);
  // Where each line's corrections end, filled newest first since a correction always comes later.
  const latest: Array<ChannelBotNoteLine> = [];
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at];
    if (line === undefined) continue;
    latest[at] = (line.replacedBy === undefined ? undefined : latest[line.replacedBy]) ?? line;
  }
  const ends = new Set<ChannelBotNoteLine>();
  for (const line of lines) {
    const end = latest[line.index];
    if (end !== undefined && collapseNoteText(line.text) === wanted) ends.add(end);
  }
  return onlyOne([...ends]);
};
