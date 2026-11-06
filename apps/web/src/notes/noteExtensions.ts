import { Extension, Node } from "@tiptap/core";
import type { EnvironmentId } from "@goat/contracts";
import { ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
} from "../composer-rich-text-doc";
import { NoteEmbedView } from "./NoteEmbedView";

export interface NoteEmbedOptions {
  /** Where embedded note files load from; without it embeds show their source. */
  readonly environmentId: EnvironmentId | null;
  readonly notePath: string | null;
}

const NoteSource = Extension.create({
  name: "noteSource",
  addGlobalAttributes() {
    return [
      {
        types: [
          "paragraph",
          "heading",
          "bulletList",
          "orderedList",
          "taskList",
          "blockquote",
          "codeBlock",
          "horizontalRule",
          "noteEmbed",
        ],
        attributes: {
          notePrefix: { default: "", rendered: false },
          noteSource: { default: null, rendered: false },
          noteFingerprint: { default: null, rendered: false },
          noteSuffix: { default: "\n\n", rendered: false },
          noteNext: { default: null, rendered: false },
        },
      },
    ];
  },
});

const NoteRawMarkdown = Node.create({
  name: "noteRawMarkdown",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes: () => ({
    notePrefix: { default: "", rendered: false },
    noteSuffix: { default: "\n\n", rendered: false },
    noteNext: { default: null, rendered: false },
  }),
  parseHTML: () => [{ tag: "pre[data-note-raw]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-note-raw": "", "aria-label": "Raw markdown" }, ["code", {}, 0]],
});

// Attributes travel as data-* so copying an embed between notes keeps it.
const dataAttribute = (name: string, fallback: string | null) => ({
  default: fallback,
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) ?? fallback,
  renderHTML: (attributes: Record<string, unknown>) =>
    typeof attributes[name] === "string" ? { [`data-${name}`]: attributes[name] } : {},
});

const NoteEmbed = Node.create<NoteEmbedOptions>({
  name: "noteEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addOptions: () => ({ environmentId: null, notePath: null }),
  addAttributes: () => ({
    syntax: dataAttribute("syntax", "image"),
    src: dataAttribute("src", ""),
    text: dataAttribute("text", ""),
    title: dataAttribute("title", null),
  }),
  parseHTML: () => [{ tag: "div[data-note-embed]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", { "data-note-embed": "", ...HTMLAttributes }],
  addNodeView: () => ReactNodeViewRenderer(NoteEmbedView),
});

export function noteExtensions(embed?: NoteEmbedOptions) {
  return [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      code: false,
      link: false,
      underline: false,
      trailingNode: false,
    }),
    ComposerCodeExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
    ComposerTaskListExtension,
    ComposerTaskItemExtension,
    NoteRawMarkdown,
    embed ? NoteEmbed.configure(embed) : NoteEmbed,
    NoteSource,
  ];
}
