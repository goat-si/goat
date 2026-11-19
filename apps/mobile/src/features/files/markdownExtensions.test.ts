import { expect, it } from "vite-plus/test";
import { isMarkdownPreviewFile } from "./filePath";

it("opens common Markdown extensions regardless of case", () => {
  for (const path of ["docs/readme.markdown", "docs/readme.MDOWN", "docs/readme.mkd"]) {
    expect(isMarkdownPreviewFile(path)).toBe(true);
  }
  expect(isMarkdownPreviewFile("docs/readme.mkd.txt")).toBe(false);
});
