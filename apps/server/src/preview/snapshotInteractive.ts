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
const ENTRY = /^(\s*)- '?([a-z]+)(?=[\s"':]|$)/;
const NAME = /^\s*- '?[a-z]+ "((?:[^"\\]|\\.)*)"/;
const REF = /\[ref=([^\]\s]+)\]/;
const BOX = /\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/;
const VALUE = /\]: (.+?)'?$/;
const TEXT = /^\s*- text: (.+)$/;
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

const unquote = (text: string) => {
  if (!text.startsWith('"')) return text;
  try {
    return String(JSON.parse(text));
  } catch {
    return text;
  }
};

/** The line's role when it is an action target. */
const interactiveRole = (line: string) => {
  const role = ENTRY.exec(line)?.[2];
  if (role === undefined) return undefined;
  if (INTERACTIVE_ROLES.has(role)) return role;
  // Playwright marks only the element that sets the pointer cursor, not children inheriting it.
  return REF.test(line) && line.includes("[cursor=pointer]") ? role : undefined;
};

/** A nameless pointer container is named by its descendants' text, as agent-browser names it. */
const descendantText = (lines: ReadonlyArray<string>, index: number) => {
  const depth = ENTRY.exec(lines[index] ?? "")?.[1]?.length ?? 0;
  const parts: string[] = [];
  for (let next = index + 1; next < lines.length && next <= index + SCAN_LIMIT; next++) {
    const line = lines[next] ?? "";
    if ((/^\s*/.exec(line)?.[0].length ?? 0) <= depth) break;
    const text = TEXT.exec(line)?.[1] ?? VALUE.exec(line)?.[1];
    if (text !== undefined) parts.push(unquote(text));
    if (parts.join(" ").length >= NAME_LIMIT) break;
  }
  return parts.join(" ").slice(0, NAME_LIMIT);
};

const nameOf = (lines: ReadonlyArray<string>, index: number) => {
  const line = lines[index] ?? "";
  const quoted = NAME.exec(line)?.[1];
  if (quoted !== undefined) return unquote('"' + quoted + '"');
  if (EDITABLE.has(ENTRY.exec(line)?.[2] ?? "")) return "";
  const value = VALUE.exec(line)?.[1];
  return value === undefined ? descendantText(lines, index) : unquote(value);
};

export const narrowTree = (tree: string, interactiveOnly?: boolean) => {
  if (!interactiveOnly) return tree;
  const lines = tree.split("\n");
  return lines
    .flatMap((line, index) => {
      const role = interactiveRole(line);
      if (role === undefined) return [];
      const own = line.trimStart();
      // Ancestors are filtered out, so their indentation and child markers would invent nesting.
      const flat = own.replace(/:$/, "");
      const named = flat.length === own.length || INTERACTIVE_ROLES.has(role) || NAME.test(line);
      const text = named ? "" : descendantText(lines, index);
      // Written as the line's name, the form Playwright uses for a named element.
      return [text ? flat.replace(/^- ('?)([a-z]+)/, `- $1$2 ${JSON.stringify(text)}`) : flat];
    })
    .join("\n");
};

/** One element per interactive ref line, located by the ref the tree shows. */
export const interactiveElementsOf = (tree: string): PreviewAutomationElement[] => {
  const lines = tree.split("\n");
  return lines.flatMap((line, index) => {
    const role = interactiveRole(line);
    const ref = REF.exec(line)?.[1];
    const box = BOX.exec(line);
    // The tree is cut at a character limit; a line cut before its box has no usable element.
    if (role === undefined || ref === undefined || box === null) return [];
    return [
      {
        // The tree names roles, not HTML tags.
        tag: role,
        role,
        name: nameOf(lines, index),
        selector: "aria-ref=" + ref,
        x: Number(box[1]),
        y: Number(box[2]),
        width: Number(box[3]),
        height: Number(box[4]),
      },
    ];
  });
};
