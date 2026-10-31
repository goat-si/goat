/**
 * A large app window read in parts the model chooses: a shallow map to a given depth, and one
 * element's subtree from the same read. Both work on the driver's raw tree text, the only place
 * that still holds every node and its nesting before display folds text rows together.
 */
import { parseTree, repeatedIndexes, spansLines, type Listed } from "./DesktopTreeText.ts";

/** The driver appends this note to a walk it cut short; it is not a tree line. */
const PARTIAL_NOTE = "PARTIAL TREE";

/** The raw tree without the driver's trailing partial-walk note, and whether one was there. */
export const stripPartialNote = (
  markdown: string,
): { readonly tree: string; readonly cut: boolean } => {
  const lines = markdown.split("\n");
  const at = lines.findIndex(
    (line, position) =>
      line.includes(PARTIAL_NOTE) &&
      !/^\s*- /.test(line) &&
      lines.slice(position).every((rest) => !/^\s*- /.test(rest)),
  );
  return at < 0
    ? { tree: markdown, cut: false }
    : { tree: lines.slice(0, at).join("\n").replace(/\n+$/, ""), cut: true };
};

/** Why raw text cannot carry nesting for this read, or undefined when it can. */
export const structureProblem = (
  tree: string,
  listed: ReadonlyArray<Listed>,
): string | undefined => {
  if (tree.trim() === "") return "the read has no tree text";
  if (spansLines(tree, listed)) return "some text in this window spans lines";
  if (repeatedIndexes(parseTree(tree)).size > 0) return "this read repeats element numbers";
  return undefined;
};

/** Each raw line's nesting level: how many lines above it are its ancestors. */
const levels = (raw: ReadonlyArray<string>) => {
  const open: number[] = [];
  return raw.map((line) => {
    const indent = line.length - line.trimStart().length;
    while (open.length > 0 && (open.at(-1) ?? 0) >= indent) open.pop();
    const level = open.length;
    open.push(indent);
    return level;
  });
};

const indexOf = (line: string) => {
  const match = /^\s*- \[(\d+)\] /.exec(line);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * The raw tree to a depth below its root, and for each numbered line that lost children the
 * number of direct children dropped, as the driver returned them.
 */
export const treeToDepth = (tree: string, depth: number) => {
  const raw = tree.split("\n").filter((line) => line.trim() !== "");
  const level = levels(raw);
  const kept: string[] = [];
  const counts = new Map<number, number>();
  const parents: Array<number | undefined> = [];
  for (let position = 0; position < raw.length; position++) {
    const here = level[position] ?? 0;
    parents.length = here;
    const parent = parents[here - 1];
    if (here <= depth) kept.push(raw[position] ?? "");
    else if (here === depth + 1 && parent !== undefined)
      counts.set(parent, (counts.get(parent) ?? 0) + 1);
    parents[here] = indexOf(raw[position] ?? "");
  }
  return { text: kept.join("\n"), counts, dropped: kept.length < raw.length };
};

/** One numbered line's subtree with its ancestors as context, from the same raw tree. */
export const treeWithin = (tree: string, index: number): string | undefined => {
  const raw = tree.split("\n").filter((line) => line.trim() !== "");
  const level = levels(raw);
  const at = raw.findIndex((line) => indexOf(line) === index);
  if (at < 0 || raw.findIndex((line, position) => position > at && indexOf(line) === index) >= 0)
    return undefined;
  const own = level[at] ?? 0;
  const ancestors: string[] = [];
  let need = own;
  for (let position = at - 1; position >= 0 && need > 0; position--)
    if ((level[position] ?? 0) < need) {
      ancestors.unshift(raw[position] ?? "");
      need = level[position] ?? 0;
    }
  let end = at + 1;
  while (end < raw.length && (level[end] ?? 0) > own) end++;
  return [...ancestors, ...raw.slice(at, end)].join("\n");
};

/** The numbers a raw tree text shows. */
export const numbersIn = (tree: string): ReadonlySet<number> =>
  new Set(
    tree.split("\n").flatMap((line) => {
      const index = indexOf(line);
      return index === undefined ? [] : [index];
    }),
  );

/** Shown text with each cut numbered line followed by how many children it lost. */
export const withChildCounts = (
  shown: string,
  counts: ReadonlyMap<number, number>,
  orMore: boolean,
) =>
  shown
    .split("\n")
    .map((line) => {
      const index = indexOf(line);
      const count = index === undefined ? undefined : counts.get(index);
      return count === undefined ? line : `${line} (+${count}${orMore ? " or more" : ""})`;
    })
    .join("\n");
