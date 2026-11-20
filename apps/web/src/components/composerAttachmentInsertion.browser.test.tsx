import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { serializeEditorDoc } from "../composer-rich-text-doc";
import { formatInlineContextReference } from "../lib/composerContextReferences";
import { captureComposerAttachmentInsertion } from "./composerAttachmentInsertion";

it.each(["first", "second"] as const)(
  "keeps overlapping pastes ordered when %s finishes first",
  async (finishesFirst) => {
    await using screen = await render(<div data-testid="editor" />);
    const editor = new Editor({
      element: screen.getByTestId("editor").element(),
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        Node.create({
          name: "composer-context-reference",
          group: "inline",
          inline: true,
          atom: true,
          addAttributes: () => ({
            kind: { default: "" },
            contextId: { default: "" },
            label: { default: "" },
            source: { default: "" },
          }),
          renderHTML: () => ["span", { "data-reference": "true" }],
        }),
      ],
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Before " }] }],
      },
    });
    using _editor = { [Symbol.dispose]: () => editor.destroy() };
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    const first = captureComposerAttachmentInsertion(editor);
    const second = captureComposerAttachmentInsertion(editor);
    const one = { kind: "image", contextId: "image_first", label: "first.png" } as const;
    const two = { kind: "image", contextId: "image_second", label: "second.png" } as const;
    if (finishesFirst === "second") expect(second.insert([two])).toBe(true);
    expect(first.insert([one])).toBe(true);
    if (finishesFirst === "first") expect(second.insert([two])).toBe(true);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(
      `Before ${formatInlineContextReference(one)} ${formatInlineContextReference(two)} `,
    );
  },
);
