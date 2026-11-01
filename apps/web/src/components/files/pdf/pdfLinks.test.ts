/*
Adapted from Synara (MIT): apps/web/src/lib/pdf/pdfLinks.test.ts
MIT License

Copyright (c) 2026 T3 Tools Inc.
Copyright (c) 2026 Emanuele Di Pietro

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { describe, expect, it, vi } from "vite-plus/test";

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "./pdfEngine";
import { extractPageLinks } from "./pdfLinks";

// Identity viewport: returns the rect unchanged so the test asserts the
// min/width/height math without depending on pdf.js matrix internals.
const viewport = {
  convertToViewportPoint: (x: number, y: number) => [x, y],
} as unknown as PageViewport;

function makePage(annotations: unknown[], pageNumber = 1): PDFPageProxy {
  return {
    pageNumber,
    getAnnotations: vi.fn().mockResolvedValue(annotations),
  } as unknown as PDFPageProxy;
}

describe("extractPageLinks", () => {
  it("keeps external + resolvable internal links in order and drops inert/non-links", async () => {
    const chapterRef = { num: 7, gen: 0 };
    const doc = {
      getDestination: vi.fn().mockResolvedValue([chapterRef]),
      getPageIndex: vi.fn().mockResolvedValue(2),
    } as unknown as PDFDocumentProxy;

    const page = makePage([
      { subtype: "Link", rect: [0, 0, 10, 20], url: "https://example.com" },
      { subtype: "Link", rect: [0, 30, 10, 50], dest: "chapter1" },
      { subtype: "Link", rect: [0, 60, 10, 70] }, // inert: no url, no dest
      { subtype: "Widget", rect: [0, 80, 10, 90] }, // not a link
      { subtype: "Link", rect: [0, 90] }, // malformed rect
    ]);

    const links = await extractPageLinks({ doc, page, viewport });

    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      id: "1:0",
      url: "https://example.com/",
      left: 0,
      top: 0,
      width: 10,
      height: 20,
    });
    expect(links[0]).not.toHaveProperty("targetPageNumber");
    expect(links[1]).toMatchObject({ id: "1:1", targetPageNumber: 3 });
    expect(links[1]).not.toHaveProperty("url");
  });

  it("resolves numeric page-index destinations and drops out-of-range indexes", async () => {
    const doc = {
      numPages: 4,
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    } as unknown as PDFDocumentProxy;

    const links = await extractPageLinks({
      doc,
      page: makePage([
        { subtype: "Link", rect: [0, 0, 10, 10], dest: [2, { name: "Fit" }] },
        { subtype: "Link", rect: [0, 20, 10, 30], dest: [-1, { name: "Fit" }] },
        { subtype: "Link", rect: [0, 40, 10, 50], dest: [4, { name: "Fit" }] },
      ]),
      viewport,
    });

    expect(links).toEqual([expect.objectContaining({ id: "1:0", targetPageNumber: 3 })]);
    expect(doc.getPageIndex).not.toHaveBeenCalled();
  });

  it("memoizes named destinations per document so repeats resolve once", async () => {
    const ref = { num: 3, gen: 0 };
    const doc = {
      getDestination: vi.fn().mockResolvedValue([ref]),
      getPageIndex: vi.fn().mockResolvedValue(4),
    } as unknown as PDFDocumentProxy;

    const annotations = [
      { subtype: "Link", rect: [0, 0, 10, 10], dest: "shared" },
      { subtype: "Link", rect: [0, 20, 10, 30], dest: "shared" },
    ];

    const first = await extractPageLinks({ doc, page: makePage(annotations, 1), viewport });
    const second = await extractPageLinks({ doc, page: makePage(annotations, 2), viewport });

    expect(first.every((link) => link.targetPageNumber === 5)).toBe(true);
    expect(second.every((link) => link.targetPageNumber === 5)).toBe(true);
    // Four link occurrences across two pages, but the named dest resolves once.
    expect(doc.getDestination).toHaveBeenCalledTimes(1);
    expect(doc.getPageIndex).toHaveBeenCalledTimes(1);
  });

  it("treats an unresolvable internal link as inert", async () => {
    const doc = {
      getDestination: vi.fn().mockResolvedValue(null),
      getPageIndex: vi.fn(),
    } as unknown as PDFDocumentProxy;

    const links = await extractPageLinks({
      doc,
      page: makePage([{ subtype: "Link", rect: [0, 0, 10, 10], dest: "missing" }]),
      viewport,
    });

    expect(links).toHaveLength(0);
  });

  it("drops unsafe external annotation URLs instead of falling back to unsafeUrl", async () => {
    const doc = {
      getDestination: vi.fn(),
      getPageIndex: vi.fn(),
    } as unknown as PDFDocumentProxy;

    const links = await extractPageLinks({
      doc,
      page: makePage([
        { subtype: "Link", rect: [0, 0, 10, 10], unsafeUrl: "javascript:alert(1)" },
        { subtype: "Link", rect: [0, 20, 10, 30], url: "file:///etc/passwd" },
        { subtype: "Link", rect: [0, 40, 10, 50], url: "https://example.com" },
      ]),
      viewport,
    });

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url: "https://example.com/" });
  });
});
