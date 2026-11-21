import { markAsCompositionReplace } from "../composer-undo-grouping";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const CHIP_NODE_SELECTION_CLASS_NAME =
  "relative inline select-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-sm data-[composer-chip-selected]:after:bg-[Highlight] data-[composer-chip-selected]:after:opacity-30 data-[composer-chip-selected]:after:content-['']";

const ChipSelectionPluginKey = new PluginKey<DecorationSet>("composer-chip-range-selection");

/** Highlights chips inside a text selection; their node views draw no native highlight. */
export const ComposerChipSelectionExtension = Extension.create({
  name: "composer-chip-range-selection",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: ChipSelectionPluginKey,
        state: {
          init: (_, state) => chipSelectionDecorations(state),
          apply: (tr, old, _, state) =>
            tr.docChanged || tr.selectionSet ? chipSelectionDecorations(state) : old,
        },
        props: {
          decorations: (state) => ChipSelectionPluginKey.getState(state),
          handleDOMEvents: {
            // Chrome skips deleting a range bounded by a non-selectable chip during IME input.
            compositionstart: (view) => {
              if (ChipSelectionPluginKey.getState(view.state)?.find().length) {
                view.dispatch(markAsCompositionReplace(view.state.tr.deleteSelection()));
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});

function chipSelectionDecorations({ doc, selection }: EditorState): DecorationSet {
  if (selection.empty) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (!node.type.name.startsWith("composer-")) return true;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, { class: "composer-chip-range-selected" }),
    );
    return false;
  });
  return DecorationSet.create(doc, decorations);
}
