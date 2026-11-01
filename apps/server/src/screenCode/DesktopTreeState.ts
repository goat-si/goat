/** A desktop read's rows and shown text, parsed from the driver's state. */
import {
  desktopRows,
  matchesQuery,
  shownTree,
  treeOf,
  type DesktopQuery,
} from "./DesktopObserveRead.ts";
import { cleanActionText, isInteractive, keepTreeLines } from "./DesktopTreeText.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const array = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const natural = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export const NAMED_BY_TEXT_ROLES = ["AXRow", "AXCell", "AXOutlineRow"];
/**
 * Whether the tree text can name an element: desktopRows names only a listed element without a
 * label, from text under a row or cell line. Otherwise the text adds nothing to the rows.
 */
export const canLiftNamesFromTree = (
  elements: ReadonlyArray<Record<string, unknown>>,
  markdown: string,
) =>
  NAMED_BY_TEXT_ROLES.some((role) => markdown.includes(role)) &&
  elements.some(
    (entry) =>
      string(entry.element_token) !== undefined &&
      natural(entry.element_index) !== undefined &&
      string(entry.label) === undefined,
  );

const NUMBERED = /^- \[(\d+)\] /;
const UNNUMBERED_TEXT = /^\s*- AXStaticText/m;
/**
 * shownTree in one pass for the common case: no text line to pair, and every numbered line shows
 * its listed element as the driver writes it. Anything else goes through shownTree.
 */
export const fastShownTree = (
  markdown: string,
  elements: ReadonlyArray<Record<string, unknown>> | undefined,
  filtered: boolean,
): string => {
  const slow = () => shownTree(markdown, filtered ? undefined : elements);
  if (UNNUMBERED_TEXT.test(markdown)) return slow();
  if (!filtered && elements !== undefined) {
    // Each listed element's line head, normalized as listedOf and verifiedIndexes read them.
    const heads = new Map<number, string>();
    for (const entry of elements) {
      const index = natural(entry.element_index);
      if (index === undefined) continue;
      const label = typeof entry.label === "string" ? entry.label : undefined;
      const value = typeof entry.value === "string" ? entry.value : undefined;
      if (heads.has(index) || /[\r\n]/.test((label ?? "") + (value ?? ""))) return slow();
      const role = string(entry.role) ?? "";
      heads.set(
        index,
        "- [" + index + "] " + role + (label === undefined ? "" : ' "' + label + '"'),
      );
    }
    const seen = new Set<number>();
    for (const raw of markdown.split("\n")) {
      const line = raw.trimStart();
      const number = NUMBERED.exec(line)?.[1];
      if (number === undefined) continue;
      const index = Number(number);
      const head = heads.get(index);
      if (head === undefined || seen.has(index) || !line.startsWith(head)) return slow();
      const next = line.charAt(head.length);
      if (next !== "" && next !== " ") return slow();
      seen.add(index);
    }
  }
  return markdown.includes("name:") ? cleanActionText(markdown) : markdown;
};

/** A read's rows, the ones shown and their text, from the driver's state. */
export const parseDesktopTreeState = (input: {
  readonly state: Record<string, unknown>;
  readonly filtered: boolean;
  readonly query: DesktopQuery | undefined;
  readonly interactive: boolean;
}) => {
  const elements = array(input.state.elements)
    .map(object)
    .filter((entry) => entry !== undefined);
  const markdown = treeOf(input.state, elements, input.filtered);
  const source = string(input.state.tree_diff) ?? string(input.state.tree_markdown) ?? "";
  const lines = new Map<number, string[]>();
  for (const line of source.split("\n")) {
    const match = /^(?:\s*- |[~+] )\[(\d+)\] (.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    const index = Number(match[1]);
    lines.set(index, [...(lines.get(index) ?? []), match[2]]);
  }
  const entries = new Map<number, Record<string, unknown>[]>();
  for (const entry of elements) {
    const index = natural(entry.element_index);
    if (index !== undefined) entries.set(index, [...(entries.get(index) ?? []), entry]);
  }
  const safeText = elements.every((entry) =>
    [
      entry.label,
      entry.value,
      entry.description,
      ...(Array.isArray(entry.actions) ? entry.actions : []),
    ].every((value) => typeof value !== "string" || !/[\r\n\u2028\u2029]/.test(value)),
  );
  const rows = desktopRows(elements, canLiftNamesFromTree(elements, markdown) ? markdown : "").map(
    (row) => {
      if (
        !safeText ||
        row.index === undefined ||
        !row.name ||
        row.lifted ||
        row.name === row.text ||
        /["\r\n]/.test(row.name)
      )
        return row;
      const listed = entries.get(row.index);
      const entry = listed?.length === 1 ? listed[0] : undefined;
      if (
        !entry ||
        entry?.description === row.name ||
        (typeof entry?.title === "string" && entry.title !== row.name)
      )
        return row;
      const matches = lines.get(row.index);
      const head = `${row.role} "${row.name}"`;
      const content = matches?.[0];
      return matches?.length === 1 &&
        content?.startsWith(head) &&
        /^(?:\s|$)/.test(content.slice(head.length))
        ? { ...row, pairingTitle: row.name }
        : row;
    },
  );
  const query = input.query;
  const shown = query
    ? rows.filter((row) => matchesQuery(row, query))
    : input.interactive
      ? rows.filter(isInteractive)
      : rows;
  const treeText = fastShownTree(markdown, input.filtered ? undefined : elements, input.filtered);
  const shownText =
    query || input.interactive
      ? keepTreeLines(
          treeText,
          new Set(shown.flatMap((row) => (row.index === undefined ? [] : [row.index]))),
        )
      : treeText;
  return { elements, markdown, rows, shown, shownText };
};
