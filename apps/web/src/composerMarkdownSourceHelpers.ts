import { Mark } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { MARKDOWN_SOURCE_MARK } from "./composer-rich-text";

export function touchesMarkdownSource(state: EditorState, from: number, to: number): boolean {
  const type = state.schema.marks[MARKDOWN_SOURCE_MARK];
  if (!type) return false;
  if (from < to) return state.doc.rangeHasMark(from, to, type);
  const $pos = state.doc.resolve(from);
  return [$pos.nodeBefore, $pos.nodeAfter].some((node) => node && type.isInSet(node.marks));
}

function styleMarks(marks: readonly Mark[]): readonly Mark[] {
  return marks.filter((mark) => mark.type.name !== MARKDOWN_SOURCE_MARK);
}

export function styledEdge(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.inlineContent) return null;
  const before = styleMarks($from.nodeBefore?.marks ?? Mark.none);
  const after = styleMarks($from.nodeAfter?.marks ?? Mark.none);
  if (Mark.sameSet(before, after)) return null;
  return { before, after, current: styleMarks(state.storedMarks ?? $from.marks()) };
}
