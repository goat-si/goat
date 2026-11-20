import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export function isTrailingLineAfterRule(doc: ProseMirrorNode, index: number): boolean {
  const block = doc.child(index);
  return (
    index === doc.childCount - 1 &&
    index > 0 &&
    block.type.name === "paragraph" &&
    block.content.size === 0 &&
    doc.child(index - 1).type.name === "horizontalRule"
  );
}
