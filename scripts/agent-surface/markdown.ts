// Markdown pieces the agent surface audit renders with.
export const TICK = String.fromCharCode(96);

export const code = (text: string) => TICK + text + TICK;
export const pct = (part: number, whole: number) =>
  whole === 0 ? "0%" : Math.round((part / whole) * 100) + "%";
export const list = (names: ReadonlyArray<string>, max = 12) =>
  names.length <= max
    ? names.map(code).join(", ")
    : names.slice(0, max).map(code).join(", ") + ", and " + (names.length - max) + " more";
// Padded the way `vp fmt` pads Markdown tables, so the committed file is both
// formatted and byte-identical to a fresh render.
export const table = (
  head: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
) => {
  const cells = [head, ...rows].map((row) => row.map((cell) => String(cell).replace(/\|/g, "\\|")));
  const widths = head.map((_, column) =>
    Math.max(3, ...cells.map((row) => [...(row[column] ?? "")].length)),
  );
  const line = (row: ReadonlyArray<string>) =>
    "| " + widths.map((width, column) => (row[column] ?? "").padEnd(width)).join(" | ") + " |";
  const [header = [], ...body] = cells;
  return [
    line(header),
    "| " + widths.map((width) => "-".repeat(width)).join(" | ") + " |",
    ...body.map(line),
  ].join("\n");
};

/** Groups rows for the audit's per-toolkit, per-shape and per-family tables. */
export const groupBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string) => {
  const out = new Map<string, Array<A>>();
  for (const item of items) {
    const k = key(item);
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
};
