import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPageLinks } from "./pdfLinks";
import { findPdfMatches, indexPdfText } from "./pdfSearch";
import { layoutPages } from "./pdfLayout";
import fixture from "./fixtures/mixed.pdf?raw";

GlobalWorkerOptions.workerSrc = new URL(
  "../../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;
let document: PDFDocumentProxy | undefined;
afterEach(async () => {
  await document?.loadingTask.destroy();
});

describe("real PDF fixture", () => {
  it("reads mixed page sizes, searches the last page and resolves internal and external links", async () => {
    const data = new TextEncoder().encode(fixture);
    document = await getDocument({ data, useSystemFonts: true }).promise;
    const sizes = await Promise.all(
      [1, 2, 3].map(async (number) => {
        const page = await document!.getPage(number);
        const { width, height } = page.getViewport({ scale: 1 });
        return { width, height };
      }),
    );
    expect(sizes).toEqual([
      { width: 600, height: 800 },
      { width: 1000, height: 500 },
      { width: 400, height: 1000 },
    ]);
    const pages = layoutPages(sizes, { width: 632, height: 432 }, "fit-width");
    expect(pages[1]!.height).toBe(300);
    const texts = await indexPdfText(document, new AbortController().signal);
    expect(findPdfMatches(texts, "needle").map((match) => match.page)).toEqual([0, 0, 2]);
    const page = await document.getPage(1);
    const links = await extractPageLinks({
      doc: document,
      page,
      viewport: page.getViewport({ scale: 1 }),
    });
    expect(links.map((link) => link.url ?? link.targetPageNumber)).toEqual([
      "https://example.com/",
      3,
    ]);
  });
});
