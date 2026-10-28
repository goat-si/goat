/**
 * What an over-budget desktop observation gives up first. Window chrome (toolbar, tabs, search,
 * headers) outlasts the body of tables and lists, visible elements outlast those outside the
 * window, and a table row keeps its line, with its cells' words, after its cells' numbers go.
 */

interface Line {
  readonly depth: number;
  readonly index?: number;
  readonly role: string;
}

interface Placed {
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly actions?: ReadonlyArray<string>;
  readonly frame?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const LINE = /^(\s*)- (?:\[(\d+)\] )?(\w+)/;
const TABLES: ReadonlySet<string> = new Set([
  "AXTable",
  "AXOutline",
  "AXList",
  "AXBrowser",
  "AXGrid",
]);
const ROWS: ReadonlySet<string> = new Set(["AXRow", "AXOutlineRow"]);
const HEADERS: ReadonlySet<string> = new Set(["AXColumn", "AXHeader"]);
const CONTAINERS: ReadonlySet<string> = new Set([
  "AXGroup",
  "AXScrollArea",
  "AXSplitGroup",
  "AXLayoutArea",
  "AXUnknown",
]);
const PASSIVE: ReadonlySet<string> = new Set([
  "AXShowDefaultUI",
  "AXShowAlternateUI",
  "AXShowMenu",
  "AXScrollToVisible",
  "AXRaise",
]);

const parse = (markdown: string): ReadonlyArray<Line | undefined> =>
  markdown.split("\n").map((line) => {
    const parsed = LINE.exec(line);
    return parsed
      ? {
          depth: (parsed[1] ?? "").length,
          role: parsed[3] ?? "",
          ...(parsed[2] === undefined ? {} : { index: Number(parsed[2]) }),
        }
      : undefined;
  });

/** Walks the tree, giving each line its nearest numbered ancestor and its ancestors' roles. */
const walk = (
  lines: ReadonlyArray<Line | undefined>,
  visit: (
    line: Line,
    owner: number | undefined,
    ancestors: ReadonlyArray<Line>,
    position: number,
  ) => void,
) => {
  const open: Line[] = [];
  lines.forEach((line, position) => {
    if (!line) return;
    while (open.length > 0 && (open.at(-1)?.depth ?? 0) >= line.depth) open.pop();
    const owner = [...open].reverse().find((ancestor) => ancestor.index !== undefined)?.index;
    visit(line, owner, open, position);
    open.push(line);
  });
};

const outside = (element: Placed, viewport: Viewport | undefined) => {
  const frame = element.frame;
  if (!viewport || !frame) return false;
  return (
    frame.x + frame.width <= viewport.x ||
    frame.y + frame.height <= viewport.y ||
    frame.x >= viewport.x + viewport.width ||
    frame.y >= viewport.y + viewport.height
  );
};

export interface DesktopCut {
  /** Element indexes in the order they are given up. */
  readonly order: ReadonlyArray<number>;
  /** Rows whose cells go before they do: their line carries the cells' words. */
  readonly compactRows: ReadonlySet<number>;
}

/**
 * The order an over-budget read drops elements in: unnamed action-less containers that hold
 * other elements, rows a same-named actionable cell covers, the cells of table rows (whose rows
 * then carry their words), table body outside the window and then the rest of it, chrome
 * outside the window, and last whatever remains from the end.
 */
export const desktopCutOrder = (
  elements: ReadonlyArray<Placed>,
  markdown: string,
  viewport?: Viewport,
): DesktopCut => {
  const body = new Set<number>();
  const children = new Map<number, number[]>();
  walk(parse(markdown), (line, owner, ancestors) => {
    if (line.index === undefined) return;
    const table = ancestors.findIndex((ancestor) => TABLES.has(ancestor.role));
    const inside = table < 0 ? [] : ancestors.slice(table + 1);
    // Column headers and sort buttons sit inside the table but are chrome.
    const header =
      HEADERS.has(line.role) ||
      inside.some((ancestor) => HEADERS.has(ancestor.role)) ||
      (line.role === "AXButton" && !inside.some((ancestor) => ROWS.has(ancestor.role)));
    if (table >= 0 && !header) body.add(line.index);
    if (owner !== undefined) children.set(owner, [...(children.get(owner) ?? []), line.index]);
  });
  const byIndex = new Map(elements.map((element) => [element.index, element]));
  const acts = (element: Placed | undefined) =>
    (element?.actions ?? []).some((action) => !PASSIVE.has(action));
  const order: number[] = [];
  const taken = new Set<number>();
  const take = (indexes: Iterable<number>) => {
    for (const index of indexes)
      if (byIndex.has(index) && !taken.has(index)) {
        taken.add(index);
        order.push(index);
      }
  };
  const kids = (index: number) => (children.get(index) ?? []).filter((child) => byIndex.has(child));
  take(
    elements
      .filter(
        (element) =>
          CONTAINERS.has(element.role) &&
          element.name === "" &&
          !acts(element) &&
          kids(element.index).length > 0,
      )
      .map((element) => element.index),
  );
  take(
    elements
      .filter(
        (element) =>
          ROWS.has(element.role) &&
          kids(element.index).some((child) => {
            const cell = byIndex.get(child);
            return (
              cell !== undefined && cell.name !== "" && cell.name === element.name && acts(cell)
            );
          }),
      )
      .map((element) => element.index),
  );
  const compactRows = new Set<number>();
  for (const element of elements)
    if (ROWS.has(element.role) && body.has(element.index) && !taken.has(element.index)) {
      const cells = kids(element.index);
      if (cells.length === 0) continue;
      compactRows.add(element.index);
      take(cells);
    }
  const last = [...elements].reverse();
  const indexes = (list: ReadonlyArray<Placed>) => list.map((element) => element.index);
  take(indexes(last.filter((element) => body.has(element.index) && outside(element, viewport))));
  take(indexes(last.filter((element) => body.has(element.index))));
  take(indexes(last.filter((element) => outside(element, viewport))));
  take(indexes(last));
  return { order, compactRows };
};

/**
 * The tree text after a cut: a dropped element's line and the plain lines under it go, while a
 * kept element keeps its line even when its parent went; a compacted row's line ends with its
 * dropped cells' words (`| WindowServer | 72.9`).
 */
export const cutTreeText = (
  markdown: string,
  dropped: ReadonlySet<number>,
  compactRows: ReadonlySet<number>,
  wordsOf: (index: number) => string,
): string => {
  const raw = markdown.split("\n");
  const keep = raw.map(() => true);
  const rowWords = new Map<number, string[]>();
  walk(parse(markdown), (line, owner, _ancestors, position) => {
    if (line.index === undefined) {
      keep[position] = owner === undefined || !dropped.has(owner);
      return;
    }
    if (!dropped.has(line.index)) return;
    keep[position] = false;
    if (owner !== undefined && compactRows.has(owner) && !dropped.has(owner)) {
      const words = wordsOf(line.index).trim();
      if (words) rowWords.set(owner, [...(rowWords.get(owner) ?? []), words]);
    }
  });
  const lines = parse(markdown);
  return raw
    .flatMap((text, position) => {
      if (!keep[position]) return [];
      const index = lines[position]?.index;
      const words = index === undefined ? undefined : rowWords.get(index);
      return [words ? `${text} | ${words.join(" | ")}`.slice(0, text.length + 200) : text];
    })
    .join("\n");
};

/** What an over-budget desktop read left out, and where the next part starts (≤ 200 characters). */
export const cutDetail = (dropped: ReadonlyArray<number>, next: number | undefined) => {
  const sorted = [...dropped].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end++;
    ranges.push(start === end ? `[${sorted[start]}]` : `[${sorted[start]}]–[${sorted[end]}]`);
    start = end + 1;
  }
  const tail = next === undefined ? "." : `; observe({after:${next}}) reads the next part.`;
  const head = `Left out ${sorted.length} elements (`;
  let list = ranges.join(", ");
  const room = 200 - head.length - tail.length - 1;
  if (list.length > room) list = `${list.slice(0, Math.max(0, room - 1))}…`;
  return `${head}${list})${tail}`;
};
