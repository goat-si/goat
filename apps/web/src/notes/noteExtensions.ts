import { Extension, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerCodeExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
} from "../composer-rich-text-doc";

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
        ],
        attributes: {
          notePrefix: { default: "", rendered: false },
          noteSource: { default: null, rendered: false },
          noteFingerprint: { default: null, rendered: false },
          noteSuffix: { default: "\n\n", rendered: false },
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
  }),
  parseHTML: () => [{ tag: "pre[data-note-raw]", preserveWhitespace: "full" }],
  renderHTML: () => ["pre", { "data-note-raw": "", "aria-label": "Raw markdown" }, ["code", {}, 0]],
});

export function noteExtensions() {
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
    NoteSource,
  ];
}
