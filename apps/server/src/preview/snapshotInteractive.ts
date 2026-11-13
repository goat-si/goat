import type { PreviewAutomationElement } from "@goat/contracts";

/** agent-browser's interactive roles (cli/src/native/snapshot.rs:107-126); its Iframe is iframe. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "treeitem",
  "iframe",
]);
// Fields whose content is the user's input, never the element's name (as ScreenObservations reads them).
const EDITABLE: ReadonlySet<string> = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
]);
// Roles whose part of an ancestor's name is aria-valuetext or aria-valuenow, which the tree omits.
const VALUED: ReadonlySet<string> = new Set([
  "slider",
  "spinbutton",
  "progressbar",
  "meter",
  "scrollbar",
]);
const NAME_LIMIT = 100;
const SCAN_LIMIT = 50;

// Playwright's key: role, a JSON name or a raw one that starts and ends with "/", then attributes.
// No attribute holds "/" or "]" and a key holding ": " is single-quoted, so a longer /…/ name's
// closing "/" can't pass for an attribute or value: trying a lone "/" first is exact.
const NAME = String.raw`"(?:[^"\\]|\\.)*"|\/|\/.*?\/`;
const ATTRIBUTES = String.raw`(?: \[[^\]\/]*\])*`;
const LINE = new RegExp(
  String.raw`^(\s*)- (?:'((?:[^']|'')*)'|([a-z]+(?: (?:${NAME}))?${ATTRIBUTES}))(?:(:)(?: (.*))?)?$`,
);
const KEY_PARTS = new RegExp(`^([a-z]+)(?: (${NAME}))?(${ATTRIBUTES})$`);
const BOX = /^box=(-?\d+),(-?\d+),(\d+),(\d+)$/;
// Playwright prefixes a frame's refs with f<n>; their boxes are measured from the frame's corner.
const FRAME_REF = /(?:^|-)f\d+e\d+$/;

const unquote = (text: string) => {
  if (!text.startsWith('"')) return text;
  try {
    // Playwright writes other control characters as YAML \xNN, which JSON does not read.
    const json = text.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (escape, code: string) =>
      code.length === 3 ? `\\u00${code.slice(1)}` : escape,
    );
    return String(JSON.parse(json));
  } catch {
    return text;
  }
};

const indentOf = (line: string) => /^\s*/.exec(line)?.[0].length ?? 0;

/** One element line of the tree, with its ref, box and cursor read only from its own attributes. */
const entryOf = (line: string) => {
  const parsed = LINE.exec(line);
  const key = parsed?.[2]?.replaceAll("''", "'") ?? parsed?.[3];
  const parts = key === undefined ? null : KEY_PARTS.exec(key);
  if (!parsed || !parts) return undefined;
  const [, role = "", name, run = ""] = parts;
  const attributes = [...run.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1] ?? "");
  const ref = attributes.find((attribute) => attribute.startsWith("ref="))?.slice("ref=".length);
  const box = attributes.map((attribute) => BOX.exec(attribute)).find((match) => match !== null);
  return {
    depth: parsed[1]?.length ?? 0,
    role,
    name: name === undefined ? undefined : unquote(name),
    run,
    ref,
    box: box && {
      x: Number(box[1]),
      y: Number(box[2]),
      width: Number(box[3]),
      height: Number(box[4]),
    },
    // Playwright marks only the element that sets the pointer cursor, not children inheriting it.
    target:
      INTERACTIVE_ROLES.has(role) || (ref !== undefined && attributes.includes("cursor=pointer")),
    children: parsed[4] !== undefined && parsed[5] === undefined,
    value: parsed[5] === undefined ? undefined : unquote(parsed[5]),
  };
};
type Entry = NonNullable<ReturnType<typeof entryOf>>;

const rowsOf = (tree: string) =>
  tree.split("\n").map((line) => ({ line, indent: indentOf(line), entry: entryOf(line) }));
type Row = ReturnType<typeof rowsOf>[number];

/**
 * The text lines directly under an element. Every element under it keeps its text: the tree draws
 * an editable region like any wrapper, so its words may be input.
 */
const ownText = (rows: ReadonlyArray<Row>, index: number) => {
  const depth = rows[index]?.indent ?? 0;
  const parts: string[] = [];
  let skipped = Infinity;
  for (const { indent, entry } of rows.slice(index + 1, index + 1 + SCAN_LIMIT)) {
    if (indent <= depth) break;
    if (indent > skipped) continue;
    const text = entry?.role === "text" ? entry.value : undefined;
    skipped = entry?.role === "text" ? Infinity : indent;
    if (text) parts.push(text);
    if (parts.join(" ").length >= NAME_LIMIT) break;
  }
  return parts.join(" ").slice(0, NAME_LIMIT);
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a field shows its content: as its value, a text line directly under it, or a select's
 * options. Playwright leaves out the text inside a role=textbox editor, whatever else it draws there.
 */
const showsContent = (rows: ReadonlyArray<Row>, index: number, field: Entry) => {
  if (field.value !== undefined) return true;
  const depth = rows[index]?.indent ?? 0;
  const child = rows[index + 1]?.indent;
  for (let next = index + 1; ; next++) {
    const row = rows[next];
    if (row === undefined || row.indent <= depth) return false;
    if (row.indent !== child) continue;
    const role = row.entry?.role;
    if (role === "text" || (role === "option" && field.role === "combobox")) return true;
  }
};

/**
 * Whether a name may hold text from under the element: text shown there (a field's value when they
 * share a word, as Playwright adds CSS content to it), a field's hidden content, or a cut tree's lost
 * lines. Beside a field, a name holding its own text lines, or with none, came from content.
 */
const borrowsText = (rows: ReadonlyArray<Row>, index: number, name: string, cut: boolean) => {
  const depth = rows[index]?.indent ?? 0;
  const own = squash(name);
  let ownLines = 0;
  let fromContent = false;
  let field = false;
  let nested = Infinity;
  let inField = Infinity;
  const settled = () => field && (fromContent || ownLines === 0);
  const holds = (text: string | undefined) => {
    const shown = text === undefined ? "" : squash(text);
    return shown !== "" && own.includes(shown);
  };
  const overlaps = (text: string | undefined) => {
    const shown = text === undefined ? "" : squash(text);
    if (shown === "") return false;
    return shown.includes(own) || shown.split(" ").some((word) => own.includes(word));
  };
  for (let next = index + 1; ; next++) {
    const row = rows[next];
    if (row === undefined) return cut || settled();
    if (row.indent <= depth) return settled();
    if (row.indent <= nested) nested = Infinity;
    if (row.indent <= inField) inField = Infinity;
    const { entry } = row;
    if (nested === Infinity && entry?.role === "text") {
      const line = squash(entry.value ?? "");
      ownLines += line ? 1 : 0;
      fromContent ||= line !== "" && own.includes(line);
      continue;
    }
    nested = Math.min(nested, row.indent);
    // An image's name is its alt text, which the page writes.
    if (entry === undefined || entry.role === "img") continue;
    if (VALUED.has(entry.role)) return true;
    if (EDITABLE.has(entry.role)) {
      field = true;
      inField = Math.min(inField, row.indent);
      if (!showsContent(rows, next, entry)) return true;
    }
    if (holds(entry.name) || holds(entry.value)) return true;
    if (inField !== Infinity && overlaps(entry.value)) return true;
  }
};

/** The name a target is listed under: its own, or its own text lines when that name borrows. */
const safeName = (rows: ReadonlyArray<Row>, index: number, entry: Entry, cut: boolean) =>
  entry.name === undefined ||
  !entry.children ||
  EDITABLE.has(entry.role) ||
  // A frame's content is another document, which its name can't take text from.
  entry.role === "iframe" ||
  !borrowsText(rows, index, entry.name, cut)
    ? entry.name
    : ownText(rows, index);

const nameOf = (rows: ReadonlyArray<Row>, index: number, entry: Entry, cut: boolean) => {
  const name = safeName(rows, index, entry, cut);
  if (name !== undefined) return name;
  if (EDITABLE.has(entry.role)) return "";
  return entry.value ?? ownText(rows, index);
};

export const narrowTree = (tree: string, interactiveOnly?: boolean) => {
  if (!interactiveOnly) return tree;
  const rows = rowsOf(tree);
  return rows
    .flatMap(({ line, entry }, index) => {
      if (!entry?.target) return [];
      // Ancestors are filtered out, so their indentation and child markers would invent nesting.
      const own = line.trimStart();
      if (!entry.children) return [own];
      const name = safeName(rows, index, entry, false);
      if (name !== undefined && name === entry.name) return [own.slice(0, -1)];
      const text = name ?? (INTERACTIVE_ROLES.has(entry.role) ? "" : ownText(rows, index));
      // Written as the line's name, the form Playwright uses for a named element.
      return [
        text
          ? `- ${entry.role} ${JSON.stringify(text)}${entry.run}`
          : `- ${entry.role}${entry.run}`,
      ];
    })
    .join("\n");
};

/**
 * One element per interactive ref line, located by the ref the tree shows. `cut` says the tree may
 * stop inside an element's children.
 */
export const interactiveElementsOf = (tree: string, cut: boolean): PreviewAutomationElement[] => {
  const rows = rowsOf(tree);
  return rows.flatMap(({ entry }, index) => {
    // An element is located by its own ref and box; a line without both has no usable element.
    if (!entry?.target || entry.ref === undefined || entry.box === undefined) return [];
    return [
      {
        // The tree names roles, not HTML tags.
        tag: entry.role,
        role: entry.role,
        name: nameOf(rows, index, entry, cut),
        selector: "aria-ref=" + entry.ref,
        // A coordinate click reads viewport pixels, which a frame's box is not.
        ...(FRAME_REF.test(entry.ref) ? {} : entry.box),
      },
    ];
  });
};
