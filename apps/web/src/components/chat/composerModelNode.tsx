import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ContextChip } from "../ContextChip";

function ModelNodeView({ node }: NodeViewProps) {
  const model = `${String(node.attrs.instanceId)}/${String(node.attrs.model)}`;
  return (
    <NodeViewWrapper as="span" contentEditable={false} data-composer-model-chip="true">
      <ContextChip kind="neutral" aria-label={`Model ${model}`}>
        {model}
      </ContextChip>
    </NodeViewWrapper>
  );
}

export const ComposerModelExtension = Node.create({
  name: "composer-model",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    instanceId: { default: "" },
    model: { default: "" },
    source: { default: "" },
  }),
  parseHTML: () => [{ tag: "span[data-composer-model]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", { "data-composer-model": "", ...HTMLAttributes }],
  addNodeView: () => ReactNodeViewRenderer(ModelNodeView),
});
