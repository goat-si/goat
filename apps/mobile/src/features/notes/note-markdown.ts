import { toggleNoteCheckbox, type NoteCheckbox } from "@goat/client-runtime/notes";
import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Hermes cannot run the shipped WebAssembly parser, and native exposes no source positions.
// Keep the original bytes for offsets; use the existing slot rules only as candidates, then verify native tap identity.
const parser = unified().use(remarkParse).use(remarkGfm);
type MobileNoteCheckbox = NoteCheckbox & { readonly text: string };

function plainText(node: Root | RootContent): string {
  if (node.type === "break") return "\u0000";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return "\uFFFC";
  return "children" in node ? node.children.map(plainText).join("") : "";
}

function normalizeTaskText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function taskText(node: RootContent, checked: boolean | null | undefined): string | null {
  let text = "";
  let unknown = false;
  let ended = false;
  const visit = (part: RootContent) => {
    if (ended) return;
    if (part.type === "break") ended = true;
    // Native footnotes and images have no proven text representation in remark.
    else if (
      part.type === "footnoteReference" ||
      part.type === "image" ||
      part.type === "imageReference"
    )
      unknown = true;
    else if ("value" in part) text += part.value;
    else if ("children" in part) for (const child of part.children) visit(child);
  };
  visit(node);
  return unknown
    ? null
    : normalizeTaskText(text.replace(checked == null ? /^\[[ xX]\](?:[ \t]+|$)/ : /^$/, ""));
}

function sourceTaskTextIsUnique(markdown: string, root: Root, text: string): boolean {
  const labels = new Map<number, string | null>();
  const definitions: string[] = [];
  const inlineMarkers = new Set<number>();
  const visit = (node: Root | RootContent) => {
    // Only reference identity affects text; raw source may contain list/quote continuation prefixes.
    if (node.type === "definition") definitions.push(`[${node.identifier}]: /`);
    if (node.type === "listItem") {
      const start = node.position?.start.offset;
      if (start !== undefined) {
        const marker = /^([-+*]|\d{1,9}[.)])[ \t]+(\[[ xX]\])(?=[ \t\r\n]|$)/.exec(
          markdown.slice(start),
        );
        const first = node.children[0];
        if (marker && first && ["paragraph", "heading", "table"].includes(first.type))
          labels.set(start + marker[0].length - 3, taskText(first, node.checked));
      }
    }
    if (node.type === "text" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        for (const marker of markdown.slice(start, end).matchAll(/\[[ xX]\](?=[ \t\r\n]|$)/g)) {
          const offset = start + marker.index;
          const lineStart = markdown.lastIndexOf("\n", offset - 1) + 1;
          // Preserve task-like starts even when remark absorbs them into inline content.
          if (!/(?:[-+*]|\d{1,9}[.)])[ \t]+$/.test(markdown.slice(lineStart, offset)))
            inlineMarkers.add(offset);
        }
      }
    }
    // Excluded footnote tasks still participate in native identity ambiguity.
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(root);
  let matches = 0;
  for (const marker of markdown.matchAll(/\[[ xX]\](?=[ \t\r\n]|$)/g)) {
    if (inlineMarkers.has(marker.index)) continue;
    let label = labels.get(marker.index);
    if (!labels.has(marker.index)) {
      const lineEnd = markdown.indexOf("\n", marker.index);
      const end = lineEnd === -1 ? markdown.length : lineEnd;
      const followingLine = markdown.slice(end + 1).split("\n")[0] ?? "";
      // Without a list node, only an explicit block boundary proves a complete label.
      const boundary =
        /^(?:[ \t\r]*$|[-+*][ \t]+\S| {0,3}(?:`{3,}[^`]*|~{3,}.*|<\/(?:pre|div|table)>.*|-->.*)\r?$)/;
      if (!boundary.test(followingLine)) return false;
      const source = markdown.slice(marker.index + 3, end);
      const detached = parser.parse(`- [ ] ${source}\n\n${definitions.join("\n\n")}`);
      const list = detached.children[0];
      const item = list?.type === "list" ? list.children[0] : undefined;
      const first = item?.children[0];
      label = first ? taskText(first, item?.checked) : null;
    }
    if (label == null) return false;
    if (label === text) matches++;
    if (matches > 1) return false;
  }
  return matches === 1;
}

function parseCheckboxes(markdown: string, root: Root): ReadonlyArray<MobileNoteCheckbox> {
  const boxes: MobileNoteCheckbox[] = [];
  const visit = (node: Root | RootContent) => {
    // Keep footnotes out of the candidate mapping; native divergences require tap identity proof.
    if (node.type === "footnoteDefinition") return;
    if (node.type === "listItem") {
      const start = node.position?.start.offset;
      if (start !== undefined) {
        const end = markdown.indexOf("\n", start);
        const lineEnd = end === -1 ? markdown.length : end;
        const line = markdown.slice(start, lineEnd);
        const marker = /^([-+*]|\d{1,9}[.)])([ \t]+)\[([ xX])\](?=[ \t\r]|$)/.exec(line);
        const first = node.children[0];
        // MD4C assigns the slot before setext/table conversion; remark's checked flag misses it.
        const taskContent =
          first?.type === "paragraph" || first?.type === "heading" || first?.type === "table";
        const sourceLineStart = markdown.lastIndexOf("\n", start - 1) + 1;
        let column = 0;
        for (const character of markdown.slice(sourceLineStart, start + (marker?.[1]?.length ?? 0)))
          column += character === "\t" ? 4 - (column % 4) : 1;
        const markerColumn = column;
        for (const character of marker?.[2] ?? "")
          column += character === "\t" ? 4 - (column % 4) : 1;
        // More than four columns after a list marker starts code, even for an empty [ ].
        if (marker && taskContent && column - markerColumn <= 4)
          boxes.push({
            offset: start + marker[0].length - 2,
            lineStart: start,
            lineEnd,
            checked: marker[3]!.toLowerCase() === "x",
            label: line.slice(marker[0].length).trim(),
            text: normalizeTaskText(
              plainText(first)
                .replace(node.checked == null ? /^\[[ xX]\](?:[ \t]+|$)/ : /^$/, "")
                .split("\u0000")[0]!,
            ),
          });
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(root);
  return boxes;
}

export function parsedNoteCheckboxes(markdown: string): ReadonlyArray<MobileNoteCheckbox> {
  return parseCheckboxes(markdown, parser.parse(markdown));
}

export interface NoteCheckboxEvent {
  readonly index: number;
  readonly checked: boolean;
  readonly text: string;
}
/** Native events carry the new state and the first rendered line, without source positions. */
export function applyNoteCheckboxEvent(markdown: string, event: NoteCheckboxEvent): string | null {
  const root = parser.parse(markdown);
  const boxes = parseCheckboxes(markdown, root);
  const box = boxes[event.index];
  const text = typeof event.text === "string" ? normalizeTaskText(event.text) : null;
  if (
    !Number.isInteger(event.index) ||
    !box ||
    text === null ||
    box.text !== text ||
    boxes.filter((candidate) => candidate.text === text).length !== 1 ||
    !sourceTaskTextIsUnique(markdown, root, text)
  )
    return null;
  return box.checked === event.checked ? markdown : toggleNoteCheckbox(markdown, box.offset, boxes);
}
