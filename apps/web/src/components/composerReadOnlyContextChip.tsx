import { NodeViewWrapper } from "@tiptap/react";
import { CHIP_NODE_SELECTION_CLASS_NAME } from "./composerChipSelection";
import { ComposerContextReferenceChip } from "./composerContextPresentation";
import type { NodeViewProps } from "@tiptap/react";
import type { KeyboardEvent } from "react";

export function removeReadOnlyContextChip(
  event: KeyboardEvent<HTMLElement>,
  { node, editor, getPos }: Pick<NodeViewProps, "node" | "editor" | "getPos">,
) {
  // Paste and drop still add chips while dictation makes the editor read-only; a focused chip removes itself.
  if (
    editor.isEditable ||
    (event.key !== "Backspace" && event.key !== "Delete") ||
    !(event.target instanceof globalThis.Node) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  const pos = typeof getPos === "function" ? getPos() : null;
  if (typeof pos !== "number") return;
  event.preventDefault();
  editor.commands.deleteRange({ from: pos, to: pos + node.nodeSize });
}

export function ComposerContextReferenceNodeView({ node, editor, getPos }: NodeViewProps) {
  return (
    <NodeViewWrapper
      as="span"
      className={CHIP_NODE_SELECTION_CLASS_NAME}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) =>
        removeReadOnlyContextChip(event, { node, editor, getPos })
      }
    >
      <ComposerContextReferenceChip
        kind={(node.attrs.kind as string) ?? ""}
        contextId={(node.attrs.contextId as string) ?? ""}
        label={(node.attrs.label as string) ?? ""}
      />
    </NodeViewWrapper>
  );
}
