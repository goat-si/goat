import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { PDFDocumentProxy } from "./pdfEngine";

export interface PdfMatch {
  readonly page: number;
  readonly start: number;
  readonly end: number;
}

/** Preserve offsets into text items, including the line separators missing from textDivs. */
export function pageText(content: Pick<TextContent, "items">) {
  let text = "";
  const starts: number[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    starts.push(text.length);
    text += item.str + (item.hasEOL ? "\n" : "");
  }
  return { text, starts };
}

export async function indexPdfText(document: PDFDocumentProxy, signal: AbortSignal) {
  const pages: string[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    signal.throwIfAborted();
    const page = await document.getPage(number);
    signal.throwIfAborted();
    const content = await page.getTextContent();
    signal.throwIfAborted();
    pages.push(pageText(content).text);
  }
  return pages;
}

export function findPdfMatches(pages: readonly string[], query: string): PdfMatch[] {
  if (!query.trim()) return [];
  // A Unicode regexp keeps indices in the original string (lowercasing can
  // expand characters and shift every subsequent highlight).
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
    "giu",
  );
  return pages.flatMap((text, page) => {
    const breaks: { start: number; length: number }[] = [];
    let removed = 0;
    const searchable = text.replace(
      /(?<=\p{L})-\r?\n(?=\p{L})/gu,
      (lineEnd: string, offset: number) => {
        breaks.push({ start: offset - removed, length: lineEnd.length });
        removed += lineEnd.length;
        return "";
      },
    );
    // Map only removed line ends, avoiding a per-character offset array for every page.
    let nextBreak = 0;
    let shift = 0;
    const originalOffset = (offset: number, includeBoundary: boolean) => {
      for (
        let gap = breaks[nextBreak];
        gap && (includeBoundary ? gap.start <= offset : gap.start < offset);
        gap = breaks[++nextBreak]
      ) {
        shift += gap.length;
      }
      return offset + shift;
    };
    return [...searchable.matchAll(pattern)].map((match) => ({
      page,
      start: originalOffset(match.index, true),
      end: originalOffset(match.index + match[0].length, false),
    }));
  });
}

/** Rebuild only text nodes/marks, so PDF content is never interpreted as HTML. */
export function highlightPdfText(
  divs: readonly HTMLElement[],
  strings: readonly string[],
  starts: readonly number[],
  matches: readonly PdfMatch[],
  selected: PdfMatch | undefined,
) {
  divs.forEach((div, index) => {
    const text = strings[index] ?? "";
    const start = starts[index] ?? 0;
    const end = start + text.length;
    const fragments: (string | HTMLElement)[] = [];
    let position = 0;
    for (const match of matches) {
      if (match.end <= start || match.start >= end) continue;
      const from = Math.max(0, match.start - start);
      const to = Math.min(text.length, match.end - start);
      fragments.push(text.slice(position, from));
      const mark = div.ownerDocument.createElement("mark");
      mark.textContent = text.slice(from, to);
      mark.dataset.selected = String(match === selected);
      fragments.push(mark);
      position = to;
    }
    fragments.push(text.slice(position));
    div.replaceChildren(...fragments);
  });
}
