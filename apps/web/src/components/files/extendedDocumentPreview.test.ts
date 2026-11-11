import { describe, expect, it } from "vite-plus/test";

import { openRtf } from "./extendedDocumentPreview";

const html = (rtf: string) => {
  const result = openRtf(new TextEncoder().encode(rtf).buffer as ArrayBuffer);
  if (result.type !== "document") throw new Error("Expected document");
  return result.pages.map((page) => page.html);
};

describe("rich text preview paragraphs", () => {
  it("treats a backslash before a line break as a paragraph break, as TextEdit writes them", () => {
    const textEdit = String.raw`{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}
\pard\f0\fs24 \cf0 First\
Second\
\
Third}`;
    const expected = html(
      String.raw`{\rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\pard\f0\fs24 \cf0 First\par Second\par \par Third}`,
    );
    expect(html(textEdit)).toEqual(expected);
    expect(html(textEdit.replaceAll("\n", "\r\n"))).toEqual(expected);
  });
});
