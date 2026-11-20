import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { expect, it } from "vite-plus/test";
import { schema } from "./composer-rich-text-doc.testkit";
import { buildDocJson, serializeEditorDoc } from "./composer-rich-text-doc";

it("reopens a quote without adding a paragraph before its comment", () => {
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const doc = ProseMirrorNode.fromJSON(schema, {
    type: "doc",
    content: [
      { type: "blockquote", attrs: { prefix: "> " }, content: [paragraph("quoted")] },
      paragraph("Comment to it"),
    ],
  });
  const reopened = ProseMirrorNode.fromJSON(
    schema,
    buildDocJson(serializeEditorDoc(doc).value, (name) => ({ label: name, description: null })),
  );
  expect(reopened.toJSON()).toEqual(doc.toJSON());
});
