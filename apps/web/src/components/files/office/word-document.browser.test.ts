import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";
import type { DisplayPage, GlyphRunPrimitive } from "@betteroffice/docx/layout/render";
import { openWordDocument } from "./word-document";
import { withWholeMissingGlyphs } from "./word-glyphs";

const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function relationship(id: string, type: string, target: string) {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
}

/** A document with a numbered Calibri paragraph and an Arial paragraph of Thai, which no bundled face covers. */
function document_() {
  const run = (font: string, text: string) =>
    `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/></w:rPr><w:t>${text}</w:t></w:r>`;

  return new JSZip()
    .file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    )
    .file(
      "_rels/.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "officeDocument", "word/document.xml")}</Relationships>`,
    )
    .file(
      "word/_rels/document.xml.rels",
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship("rId1", "numbering", "numbering.xml")}</Relationships>`,
    )
    .file(
      "word/numbering.xml",
      `<w:numbering ${ns}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    )
    .file(
      "word/document.xml",
      `<w:document ${ns}><w:body><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run("Calibri", "Numbered")}</w:p><w:p>${run("Arial", "ภาษาไทย")}</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    )
    .generateAsync({ type: "uint8array" });
}

it("draws list numbers with the document's faces, and text no bundled face covers with the system's", async () => {
  const opened = await openWordDocument(await document_(), document.fonts);
  const drawn: { text: string; font: string }[] = [];
  using _fillText = vi
    .spyOn(OffscreenCanvasRenderingContext2D.prototype, "fillText")
    .mockImplementation(function (this: OffscreenCanvasRenderingContext2D, text) {
      drawn.push({ text, font: this.font });
    });

  await opened.paint(0, 1, 1, new AbortController().signal);

  expect(drawn.map((call) => call.text)).toEqual(expect.arrayContaining(["1.", "ภาษาไทย"]));
  expect(drawn.find((call) => call.text === "1.")?.font).toContain("Calibri");
  expect([...document.fonts].map((face) => face.family.replaceAll('"', ""))).toContain("Calibri");
});

it("joins missing glyphs only across runs styled alike, with clusters into the joined text", () => {
  const run = (text: string, at: number, style: Partial<GlyphRunPrimitive> = {}) =>
    ({
      kind: "glyphRun",
      fontId: 2,
      size: 16,
      color: "#000000",
      text,
      glyphs: [{ id: 0, x: at * 10, y: 20, cluster: 0, advance: 10 }],
      docStart: at,
      docEnd: at + 1,
      ...style,
    }) satisfies GlyphRunPrimitive;
  const page = {
    width: 100,
    height: 100,
    primitives: [run("ภ", 0), run("า", 1), run("ษ", 2, { textOutline: true })],
  } as unknown as DisplayPage;
  const measure = new OffscreenCanvas(1, 1).getContext("2d")!;

  const [joined, outlined] = withWholeMissingGlyphs(page, measure)
    .primitives as GlyphRunPrimitive[];

  expect(joined?.text).toBe("ภา");
  expect(joined?.glyphs.map((glyph) => glyph.cluster)).toEqual([0, 3]);
  expect(outlined).toMatchObject({ text: "ษ", textOutline: true });
});

it("paints readable Japanese when the missing CJK asset returns the app shell", async () => {
  const text = "日本語";
  const zip = await JSZip.loadAsync(await document_());
  zip.file(
    "word/document.xml",
    `<w:document ${ns}><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:hAnsi="MS Gothic" w:eastAsia="MS Gothic"/><w:lang w:eastAsia="ja-JP"/><w:sz w:val="48"/><w:color w:val="B03A22"/></w:rPr><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  const fetchAsset = globalThis.fetch;
  const missing: string[] = [];
  using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (!/Noto(?:Sans|Serif).*\.otf$/u.test(url)) return fetchAsset(input, init);
    missing.push(url);
    // The packaged static route serves index.html for missing assets.
    return Promise.resolve(
      new Response('<!doctype html><html><title>GOAT</title><div id="root"></div></html>', {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
  });
  const opened = await openWordDocument(
    await zip.generateAsync({ type: "uint8array" }),
    document.fonts,
  );
  using fillText = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, "fillText");
  const page = await opened.paint(0, 1, 1, new AbortController().signal);

  expect(missing.some((url) => url.includes("NotoSansJP-Regular"))).toBe(true);
  if (!page) throw new Error("Word preview did not produce a page");
  try {
    const { bitmap } = page;
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const hasTextInk = pixels.some(
      (red, index) =>
        index % 4 === 0 && red > (pixels[index + 1] ?? 0) + 60 && (pixels[index + 3] ?? 0) > 200,
    );
    expect(hasTextInk).toBe(true);
    expect(fillText.mock.calls.map(([painted]) => painted).join("")).toContain(text);
  } finally {
    page.bitmap.close();
  }
});
