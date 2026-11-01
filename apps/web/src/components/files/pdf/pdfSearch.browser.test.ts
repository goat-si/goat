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
    expect(pageText(content)).toEqual({ text: "cross\npage match", starts: [0, 6, 11] });
    expect(findPdfMatches([pageText(content).text], "cross page")).toEqual([
      { page: 0, start: 0, end: 10 },
    ]);
  });
  it("finds line-end hyphenated words and highlights their original text items", () => {
    const strings = ["the quar-", "terly report, quar-", "terly."];
    const content = { items: strings.map((str, index) => item(str, index < 2)) };
    const { text, starts } = pageText(content);
    const matches = findPdfMatches([text], "quarterly");
    expect(matches).toEqual([
      { page: 0, start: 4, end: 15 },
      { page: 0, start: 24, end: 35 },
    ]);
    expect(findPdfMatches([text], "quarterly report")).toEqual([{ page: 0, start: 4, end: 22 }]);
    expect(findPdfMatches([text], "report")).toEqual([{ page: 0, start: 16, end: 22 }]);
    expect(findPdfMatches([text], "quar")).toEqual([
      { page: 0, start: 4, end: 8 },
      { page: 0, start: 24, end: 28 },
    ]);
    expect(findPdfMatches([text], "terly")).toEqual([
      { page: 0, start: 10, end: 15 },
      { page: 0, start: 30, end: 35 },
    ]);
    const divs = strings.map(() => document.createElement("span"));
    highlightPdfText(divs, strings, starts, matches, matches[0]);
    expect(divs.map((div) => div.textContent)).toEqual(strings);
    expect(
      divs.flatMap((div) => [...div.querySelectorAll("mark")].map((mark) => mark.textContent)),
    ).toEqual(["quar-", "terly", "quar-", "terly"]);
  });
  it("dehyphenates Unicode letters without shifting UTF-16 offsets or changing other hyphens", () => {
    expect(findPdfMatches(["İ \u{10400}-\n\u{10401} needle"], "\u{10400}\u{10401}")).toEqual([
      { page: 0, start: 2, end: 8 },
    ]);
    expect(findPdfMatches(["İ \u{10400}-\n\u{10401} needle"], "NEEDLE")).toEqual([
      { page: 0, start: 9, end: 15 },
    ]);
    expect(findPdfMatches(["caf-\r\né"], "CAFÉ")).toEqual([{ page: 0, start: 0, end: 7 }]);
    expect(findPdfMatches(["bud-get 1-\n2 a- b"], "budget")).toEqual([]);
    expect(findPdfMatches(["bud-get 1-\n2 a- b"], "12")).toEqual([]);
    expect(findPdfMatches(["bud-get 1-\n2 a- b"], "ab")).toEqual([]);
    expect(findPdfMatches(["bud-get"], "bud-get")).toEqual([{ page: 0, start: 0, end: 7 }]);
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
