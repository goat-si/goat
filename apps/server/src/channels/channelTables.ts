/**
 * Markdown tables for channels that draw none (Slack, iMessage): each row becomes one bullet,
 * its first cell leading and the others named by their column. Tables inside code blocks and
 * tables whose rows have more cells than the header stay as written.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DELIMITER_CELL = /^:?-+:?$/;

/** Cells of one table line; "\\|" is a pipe inside a cell. */
function cells(line: string): Array<string> | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const inner = trimmed.replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

export function markdownTablesToLists(
  text: string,
  style: { readonly bullet: string; readonly boldFirst: boolean },
): string {
  const lines = text.split("\n");
  const out: Array<string> = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? null;
      else if (marker[0] === fence) fence = null;
      out.push(line);
      continue;
    }
    const header = fence === null ? cells(line) : null;
    const delimiter = header === null ? null : cells(lines[index + 1] ?? "");
    if (
      header === null ||
      delimiter === null ||
      delimiter.length !== header.length ||
      !delimiter.every((cell) => DELIMITER_CELL.test(cell))
    ) {
      out.push(line);
      continue;
    }
    const rows: Array<Array<string>> = [];
    let end = index + 2;
    for (; end < lines.length; end += 1) {
      const row = cells(lines[end] ?? "");
      if (row === null || (lines[end] ?? "").trim() === "") break;
      rows.push(row);
    }
    if (rows.length === 0 || rows.some((row) => row.length > header.length)) {
      out.push(line);
      continue;
    }
    for (const row of rows) {
      const first = row[0] ?? "";
      const lead = style.boldFirst && first !== "" && !/[*`_]/.test(first) ? `**${first}**` : first;
      const rest = row
        .slice(1)
        .flatMap((cell, column) =>
          cell === "" ? [] : [header[column + 1] ? `${header[column + 1]}: ${cell}` : cell],
        )
        .join(", ");
      const body = lead === "" ? rest : rest === "" ? lead : `${lead} (${rest})`;
      out.push(`${style.bullet} ${body}`);
    }
    index = end - 1;
  }
  return out.join("\n");
}
