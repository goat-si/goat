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
    return String(JSON.parse(text));
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

/**
 * A nameless element is named by its own text under it. An element there with a ref keeps its
 * text to itself: the tree shows an editable region as a plain generic, so its words are input.
 */
const descendantText = (lines: ReadonlyArray<string>, index: number, depth: number) => {
  const parts: string[] = [];
  let skipped = Infinity;
  for (let next = index + 1; next < lines.length && next <= index + SCAN_LIMIT; next++) {
    const line = lines[next] ?? "";
    const indent = indentOf(line);
    if (indent <= depth) break;
    if (indent > skipped) continue;
    const entry = entryOf(line);
    const owned = entry !== undefined && (entry.target || entry.ref !== undefined);
    skipped = owned ? indent : Infinity;
    const text = owned ? undefined : (entry?.name ?? entry?.value);
    if (text) parts.push(text);
    if (parts.join(" ").length >= NAME_LIMIT) break;
  }
  return parts.join(" ").slice(0, NAME_LIMIT);
};

const nameOf = (lines: ReadonlyArray<string>, index: number, entry: Entry) => {
  if (entry.name !== undefined) return entry.name;
  if (EDITABLE.has(entry.role)) return "";
  return entry.value ?? descendantText(lines, index, entry.depth);
};

export const narrowTree = (tree: string, interactiveOnly?: boolean) => {
  if (!interactiveOnly) return tree;
  const lines = tree.split("\n");
  return lines
    .flatMap((line, index) => {
      const entry = entryOf(line);
      if (!entry?.target) return [];
      // Ancestors are filtered out, so their indentation and child markers would invent nesting.
      const own = line.trimStart();
      if (!entry.children) return [own];
      const named = INTERACTIVE_ROLES.has(entry.role) || entry.name !== undefined;
      const text = named ? "" : descendantText(lines, index, entry.depth);
      // Written as the line's name, the form Playwright uses for a named element.
      return [text ? `- ${entry.role} ${JSON.stringify(text)}${entry.run}` : own.slice(0, -1)];
    })
    .join("\n");
};

/** One element per interactive ref line, located by the ref the tree shows. */
export const interactiveElementsOf = (tree: string): PreviewAutomationElement[] => {
  const lines = tree.split("\n");
  return lines.flatMap((line, index) => {
    const entry = entryOf(line);
    // The tree is cut at a character limit; a line cut before its box has no usable element.
    if (!entry?.target || entry.ref === undefined || entry.box === undefined) return [];
    return [
      {
        // The tree names roles, not HTML tags.
        tag: entry.role,
        role: entry.role,
        name: nameOf(lines, index, entry),
        selector: "aria-ref=" + entry.ref,
        // A coordinate click reads viewport pixels, which a frame's box is not.
        ...(FRAME_REF.test(entry.ref) ? {} : entry.box),
      },
    ];
  });
};
