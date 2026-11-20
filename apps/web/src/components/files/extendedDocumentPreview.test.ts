import { describe, expect, it } from "vite-plus/test";

import { openNotebook, openRtf } from "./extendedDocumentPreview";

it("removes terminal colors from saved notebook text outputs", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      nbformat: 4,
      cells: [
        {
          cell_type: "code",
          source: "",
          outputs: [{ output_type: "stream", text: ["\u001b[", "32m42\u001b[0m\n"] }],
        },
      ],
    }),
  );
  const result = openNotebook(bytes.buffer as ArrayBuffer);
  if (result.type !== "notebook") throw new Error("Expected notebook");
  expect(result.cells[0]?.outputs[0]?.text).toBe("42\n");
});

const html = (rtf: string) => {
  const result = openRtf(new TextEncoder().encode(rtf).buffer as ArrayBuffer);
  if (result.type !== "document") throw new Error("Expected document");
  return result.pages.map((page) => page.html);
};

describe("rich text preview paragraphs", () => {
  it("decodes Mac Roman rich text", () => {
    for (const header of [String.raw`\mac`, String.raw`\mac\ansicpg10000`]) {
      expect(html(String.raw`{\rtf1` + header + String.raw` Caf\'8e Cr\'8fme}`)).toEqual([
        "<p>Café Crème</p>",
      ]);
    }
  });
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
