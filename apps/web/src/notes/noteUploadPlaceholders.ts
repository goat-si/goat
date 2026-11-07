import { noteFileRef } from "@goat/client-runtime/notes";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Control characters cannot be written into a markdown link, so names drop them.
export const uploadName = (file: File) => file.name.replace(/[\u0000-\u001f\u007f]/g, "") || "file";

const MEDIA = /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|m4v|mp3|wav|ogg|m4a)$/i;

/** Media embeds as an image, which the note shows inline; any other file as a link. */
export function uploadEmbed(upload: { name: string; path: string }): JSONContent {
  const media = MEDIA.test(upload.path);
  return {
    type: "noteEmbed",
    attrs: {
      syntax: media ? "image" : "link",
      src: noteFileRef(upload.path),
      text: media ? upload.name.replace(/\.[^.]+$/, "") : upload.name,
      title: null,
    },
  };
}

type UploadMeta =
  | { readonly add: { readonly id: string; readonly pos: number; readonly label: string } }
  | { readonly remove: string };

const uploadKey = new PluginKey<DecorationSet>("noteUploads");

function placeholder(label: string, cancel: () => void): HTMLElement {
  const element = document.createElement("span");
  element.contentEditable = "false";
  element.className =
    "mx-1 inline-flex items-center gap-2 rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground";
  const text = document.createElement("span");
  text.textContent = label;
  element.append(text);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Cancel";
  button.className = "font-medium text-foreground underline";
  // Keep the editor's selection; the click alone cancels.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    cancel();
  });
  element.append(button);
  return element;
}

/**
 * Marks where a batch of uploads lands while it transfers. The mark follows edits; deleting the text
 * around it, or its Cancel button, cancels the batch.
 */
export function noteUploadPlugin(cancel: (id: string) => void) {
  return new Plugin<DecorationSet>({
    key: uploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous) {
        let next = previous.map(tr.mapping, tr.doc);
        for (const mark of previous.find()) {
          if (!tr.mapping.mapResult(mark.from).deleted) continue;
          const id = String(mark.spec.id);
          next = next.remove(next.find(undefined, undefined, (spec) => spec.id === id));
          // State updates must not dispatch; the cancel runs after this transaction applies.
          queueMicrotask(() => cancel(id));
        }
        const meta = tr.getMeta(uploadKey) as UploadMeta | undefined;
        if (meta && "add" in meta) {
          const { id, pos, label } = meta.add;
          next = next.add(tr.doc, [
            Decoration.widget(pos, () => placeholder(label, () => cancel(id)), { id, side: -1 }),
          ]);
        } else if (meta) {
          next = next.remove(next.find(undefined, undefined, (spec) => spec.id === meta.remove));
        }
        return next;
      },
    },
    props: { decorations: (state) => uploadKey.getState(state) },
  });
}

export const addUploadPlaceholder = (tr: Transaction, id: string, pos: number, label: string) =>
  tr.setMeta(uploadKey, { add: { id, pos, label } } satisfies UploadMeta);

export const removeUploadPlaceholder = (tr: Transaction, id: string) =>
  tr.setMeta(uploadKey, { remove: id } satisfies UploadMeta);

export function uploadPlaceholderPos(state: EditorState, id: string): number | null {
  const [mark] =
    uploadKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id) ?? [];
  return mark ? mark.from : null;
}

/**
 * Puts finished uploads where their batch was marked, in one step and at a block boundary: they
 * replace an empty paragraph, or follow the block that holds the mark. Nothing is deleted.
 */
export function insertUploads(
  state: EditorState,
  id: string,
  content: ReadonlyArray<JSONContent>,
): Transaction | null {
  const pos = uploadPlaceholderPos(state, id);
  if (pos === null) return null;
  const tr = removeUploadPlaceholder(state.tr, id);
  if (content.length === 0) return tr;
  const nodes: ProseMirrorNode[] = content.map((node) => state.schema.nodeFromJSON(node));
  const $pos = state.doc.resolve(pos);
  if ($pos.depth === 0) return tr.insert(pos, nodes);
  const block = $pos.node(1);
  return block.type.name === "paragraph" && block.content.size === 0
    ? tr.replaceWith($pos.before(1), $pos.after(1), nodes)
    : tr.insert($pos.after(1), nodes);
}
