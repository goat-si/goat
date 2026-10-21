import { describe, expect, it } from "vite-plus/test";
import { findPdfMatches, highlightPdfText, pageText } from "./pdfSearch";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

const item = (str: string, hasEOL = false) => ({ str, hasEOL }) as TextItem;
describe("document-wide PDF find", () => {
  it("finds unrendered pages, treats regex syntax literally and preserves Unicode offsets", () => {
    const matches = findPdfMatches(
      ["İ before Needle and needle.", "No match", "Final NEEDLE [a+b]."],
      "needle",
    );
    expect(matches).toEqual([
      { page: 0, start: 9, end: 15 },
      { page: 0, start: 20, end: 26 },
      { page: 2, start: 6, end: 12 },
    ]);
    expect(findPdfMatches(["Final [a+b]."], "[a+b]")).toEqual([{ page: 0, start: 6, end: 11 }]);
    expect(findPdfMatches(["anything"], "  ")).toEqual([]);
  });
  it("finds phrases across text runs and line breaks", () => {
    const content = { items: [item("cross", true), item("page "), item("match")] };
    expect(pageText(content)).toEqual({ text: "cross page match", starts: [0, 6, 11] });
    expect(findPdfMatches([pageText(content).text], "cross page")).toEqual([
      { page: 0, start: 0, end: 10 },
    ]);
  });
  it("highlights across text items without interpreting markup and clears highlights", () => {
    const strings = ["<img>cross", "page"];
    const divs = strings.map(() => document.createElement("span"));
    const match = { page: 0, start: 5, end: 14 };
    highlightPdfText(divs, strings, [0, 10], [match], match);
    expect(divs.map((div) => div.textContent)).toEqual(strings);
    expect(
      divs
        .flatMap((div) => [...div.querySelectorAll('mark[data-selected="true"]')])
        .map((mark) => mark.textContent),
    ).toEqual(["cross", "page"]);
    expect(divs[0]!.querySelector("img")).toBeNull();
    highlightPdfText(divs, strings, [0, 10], [], undefined);
    expect(divs.every((div) => div.querySelector("mark") === null)).toBe(true);
  });
});
