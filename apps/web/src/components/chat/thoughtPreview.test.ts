import type { Root } from "mdast";
import { expect, it } from "vite-plus/test";
import { remarkThoughtPreview, THOUGHT_PREVIEW_MAX_LENGTH } from "./TimelineWorkEntryRow.logic";

it("stops reading the tree once the preview is full", () => {
  const beyondCap = (): string => {
    throw new Error("read beyond cap");
  };
  const head = "x".repeat(THOUGHT_PREVIEW_MAX_LENGTH - 2);
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: head },
          { type: "strong", children: [{ type: "text", value: "yz beyond" }] },
          {
            type: "inlineMath",
            get value() {
              return beyondCap();
            },
          },
        ],
      },
      {
        type: "paragraph",
        children: [
          {
            type: "text",
            get value() {
              return beyondCap();
            },
          },
        ],
      },
    ],
  };
  remarkThoughtPreview("Reasoning")(tree);
  expect(tree.children).toEqual([{ type: "text", value: `${head}yz` }]);
});
