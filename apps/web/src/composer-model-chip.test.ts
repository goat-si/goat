import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vite-plus/test";
import { buildDocJson, serializeEditorDoc } from "./composer-rich-text-doc";

it("inserts a model chip while preserving its exact sent prompt", () => {
  const model = Node.create({
    name: "composer-model",
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => ({
      instanceId: { default: "" },
      model: { default: "" },
      source: { default: "" },
    }),
  });
  const schema = getSchemaByResolvedExtensions(resolveExtensions([StarterKit, model]));
  const text = "Ask model:codex/gpt-5.5 please";
  const doc = ProseMirrorNode.fromJSON(
    schema,
    buildDocJson(text, () => null),
  );
  const result = serializeEditorDoc(doc);
  expect(result.runs.filter((run) => run.kind === "token").map((run) => run.nodeName)).toEqual([
    "composer-model",
  ]);
  expect(result.value).toBe(text);
});
