import { Node } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { use, type CSSProperties } from "react";

import { basenameOfPath, documentIconColorForFileName } from "~/pierre-icons";
import { useNativeMentionDrag } from "../useNativeFileDrag";
import { ContextChip } from "./ContextChip";
import { FileTagChipContent } from "./chat/FileTagChip";
import { WorkspaceEntryTooltip } from "./chat/WorkspaceEntryIcon";
import { CHIP_NODE_SELECTION_CLASS_NAME } from "./composerChipSelection";
import { ComposerContextActionsContext } from "./composerContextPresentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export const ComposerMentionExtension = Node.create({
  name: "composer-mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      path: { default: "" },
      source: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-composer-mention]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-composer-mention": "", ...HTMLAttributes }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ComposerMentionNodeView);
  },
});

function ComposerMentionNodeView({ node }: NodeViewProps) {
  const actions = use(ComposerContextActionsContext);
  const path = (node.attrs.path as string) ?? "";
  const nativeFileDrag = useNativeMentionDrag(actions.environmentId, path, actions.cwd);
  const accent = documentIconColorForFileName(path);
  const chip = (
    <ContextChip
      {...nativeFileDrag}
      kind="mention"
      style={accent ? ({ "--context-chip-accent": accent } as CSSProperties) : undefined}
      dir="ltr"
      render={<button type="button" />}
      onClick={() => actions.openMention(path)}
      aria-label={`Preview ${path}`}
      contentEditable={false}
      spellCheck={false}
      data-composer-mention-chip="true"
    >
      <FileTagChipContent
        path={path}
        environmentId={actions.environmentId}
        cwd={actions.cwd}
        label={basenameOfPath(path)}
        theme={resolvedThemeFromDocument()}
      />
    </ContextChip>
  );
  return (
    <NodeViewWrapper as="span" className={CHIP_NODE_SELECTION_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top" className="pointer-events-auto">
          <WorkspaceEntryTooltip
            path={path}
            environmentId={actions.environmentId}
            cwd={actions.cwd}
          />
        </TooltipPopup>
      </Tooltip>
    </NodeViewWrapper>
  );
}
