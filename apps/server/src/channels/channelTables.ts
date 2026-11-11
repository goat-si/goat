/**
 * Markdown tables for channels that draw none (Slack, iMessage): each row becomes one bullet,
 * its first cell leading and the others named by their column. One pass over the lines; a table
 * inside a code block, one with a row it cannot split with confidence, or one whose list would
 * push the reply past the growth budget stays as written.
 */

/** Longer replies are sent as written, so the work per reply stays bounded. */
export const TABLE_TEXT_LIMIT = 200_000;
/** Characters all lists in one reply may add over the tables they replace. */
export const TABLE_GROWTH_LIMIT = 8_000;
const MAX_LINE = 2_000;
const MAX_COLUMNS = 20;

const DELIMITER_CELL = /^:?-+:?$/;
const BACKTICK_FENCE = /^ {0,3}(`{3,})[^`]*$/;
const TILDE_FENCE = /^ {0,3}(~{3,})/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** Lines that start another Markdown block end a table (GFM). */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-+*][ \t]|\d{1,9}[.)][ \t]|`{3,}|~{3,})/;
const INDENTED_CODE = /^(?: {4}|\t)/;
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y;

type Fence = { readonly char: string; readonly length: number };

function openingFence(line: string): Fence | null {
  const marker = BACKTICK_FENCE.exec(line)?.[1] ?? TILDE_FENCE.exec(line)?.[1];
  return marker === undefined ? null : { char: marker[0] ?? "", length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = CLOSING_FENCE.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence.char && marker.length >= fence.length;
}

const unescapedPipe = (text: string) => /(?<!\\)\|/.test(text);

/**
 * Cells of one table line, "uncertain" when a pipe sits inside inline code, a link or an
 * autolink, and null for a line with no pipe. "\|" is a pipe inside a cell.
 */
function parseRow(line: string): Array<string> | "uncertain" | null {
  if (!line.includes("|")) return null;
  if (line.length > MAX_LINE) return "uncertain";
  const text = line.trim();
  const cells: Array<string> = [];
  // Searches that found no closer are not repeated, so a line costs linear time.
  const noCloser = new Set<string>();
  let cell = "";
  let index = text.startsWith("|") ? 1 : 0;
  let endedWithPipe = false;
  const region = (end: number): "uncertain" | undefined => {
    const span = text.slice(index, end);
    if (unescapedPipe(span)) return "uncertain";
    cell += span.replaceAll("\\|", "|");
    index = end;
    return undefined;
  };
  while (index < text.length) {
    const char = text[index] ?? "";
    endedWithPipe = false;
    if (char === "\\") {
      const next = text[index + 1];
      cell += next === "|" ? "|" : char + (next ?? "");
      index += 2;
      continue;
    }
    if (char === "|") {
      cells.push(cell.trim());
      cell = "";
      index += 1;
      endedWithPipe = true;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (text[index + run] === "`") run += 1;
      const key = `\`${run}`;
      let close = -1;
      if (!noCloser.has(key)) {
        for (let from = index + run; ;) {
          const at = text.indexOf("`".repeat(run), from);
          if (at === -1) break;
          let after = at + run;
          while (text[after] === "`") after += 1;
          if (after - at === run) {
            close = at;
            break;
          }
          from = after;
        }
        if (close === -1) noCloser.add(key);
      }
      if (close === -1) {
        cell += text.slice(index, index + run);
        index += run;
      } else if (region(close + run) === "uncertain") return "uncertain";
      continue;
    }
    if (char === "[" && !noCloser.has("]")) {
      const close = text.indexOf("]", index + 1);
      if (close === -1) noCloser.add("]");
      else {
        const destination =
          text[close + 1] === "(" && !noCloser.has(")") ? text.indexOf(")", close + 2) : -1;
        if (text[close + 1] === "(" && destination === -1) noCloser.add(")");
        if (region(destination === -1 ? close + 1 : destination + 1) === "uncertain")
          return "uncertain";
        continue;
      }
    }
    if (char === "<") {
      AUTOLINK.lastIndex = index;
      if (AUTOLINK.test(text)) {
        if (region(AUTOLINK.lastIndex) === "uncertain") return "uncertain";
        continue;
      }
    }
    cell += char;
    index += 1;
  }
  if (!endedWithPipe || cell.trim() !== "") cells.push(cell.trim());
  return cells;
}

/** Header or delimiter cells; null when the line cannot start a table. */
function headerCells(line: string): Array<string> | null {
  if (INDENTED_CODE.test(line) || BLOCK_START.test(line)) return null;
  const cells = parseRow(line);
  return Array.isArray(cells) && cells.length <= MAX_COLUMNS ? cells : null;
}

function listItem(
  row: ReadonlyArray<string>,
  header: ReadonlyArray<string>,
  style: { readonly bullet: string; readonly boldFirst: boolean },
): string {
  const first = row[0] ?? "";
  const lead = style.boldFirst && first !== "" && !/[*`_]/.test(first) ? `**${first}**` : first;
  const rest = row
    .slice(1)
    .flatMap((cell, column) =>
      cell === "" ? [] : [header[column + 1] ? `${header[column + 1]}: ${cell}` : cell],
    )
    .join(", ");
  const body = lead === "" ? rest : rest === "" ? lead : `${lead} (${rest})`;
  return `${style.bullet} ${body}`;
}

export function markdownTablesToLists(
  text: string,
  style: { readonly bullet: string; readonly boldFirst: boolean },
): string {
  if (text.length > TABLE_TEXT_LIMIT || !text.includes("|")) return text;
  const lines = text.split("\n");
  const out: Array<string> = [];
  let fence: Fence | null = null;
  let growth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      out.push(line);
      continue;
    }
    fence = openingFence(line);
    const header = fence === null ? headerCells(line) : null;
    const delimiter = header === null ? null : headerCells(lines[index + 1] ?? "");
    if (
      header === null ||
      delimiter === null ||
      delimiter.length !== header.length ||
      !delimiter.every((cell) => DELIMITER_CELL.test(cell))
    ) {
      out.push(line);
      continue;
    }
    // Every line of the block is read once: a block that cannot become a list is kept whole.
    let end = index + 2;
    let certain = true;
    const rows: Array<Array<string>> = [];
    for (; end < lines.length; end += 1) {
      const raw = lines[end] ?? "";
      if (raw.trim() === "" || BLOCK_START.test(raw)) break;
      const row = parseRow(raw);
      if (row === null) break;
      if (row === "uncertain" || row.length > header.length) certain = false;
      else if (certain) rows.push(row);
    }
    const block = lines.slice(index, end);
    index = end - 1;
    let budget = TABLE_GROWTH_LIMIT - growth + block.reduce((sum, raw) => sum + raw.length + 1, 0);
    const items: Array<string> = [];
    for (const row of certain ? rows : []) {
      const item = listItem(row, header, style);
      budget -= item.length + 1;
      if (budget < 0) break;
      items.push(item);
    }
    if (items.length === 0 || items.length < rows.length) {
      out.push(...block);
      continue;
    }
    growth = TABLE_GROWTH_LIMIT - Math.min(TABLE_GROWTH_LIMIT, budget);
    out.push(...items);
  }
  return out.join("\n");
}
