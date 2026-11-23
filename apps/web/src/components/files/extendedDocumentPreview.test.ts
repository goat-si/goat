import { describe, expect, it } from "vite-plus/test";
import JSZip from "jszip";

import { openDocument, openNotebook, openRtf } from "./extendedDocumentPreview";

it("renders built ODT indexes without their source templates", async () => {
  const names = [
    "table-of-content",
    "illustration-index",
    "table-index",
    "object-index",
    "user-index",
    "alphabetical-index",
    "bibliography",
  ];
  const indexes = names
    .map(
      (name) =>
        `<text:${name}><text:${name}-source><text:index-title-template>Index</text:index-title-template><text:${name}-entry-template><text:index-entry-span>: </text:index-entry-span></text:${name}-entry-template></text:${name}-source><text:index-body><text:index-title><text:p>Index</text:p></text:index-title><text:p>Field notes: 1</text:p></text:index-body></text:${name}>`,
    )
    .join("");
  const archive = new JSZip().file(
    "content.xml",
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${indexes}</office:text></office:body></office:document-content>`,
  );
  const result = await openDocument(archive, "odt");
  if (result.type !== "document") throw new Error("Expected document");
  expect(result.pages[0]?.html).toBe("<p>Index</p><p>Field notes: 1</p>".repeat(names.length));
});

it("keeps OpenDocument image descriptions in image alt text", async () => {
  const archive = new JSZip()
    .file(
      "content.xml",
      '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:l="http://www.w3.org/1999/xlink" xmlns:s="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0">' +
        '<office:body><office:text><text:p><draw:frame><draw:image l:href="picture.png"/><s:title>Logo</s:title><s:desc>Research &amp; &quot;Design&quot;</s:desc></draw:frame>Visible caption</text:p></office:text></office:body></office:document-content>',
    )
    .file(
      "picture.png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      { base64: true },
    );

  const result = await openDocument(archive, "odt");
  if (result.type !== "document") throw new Error("Expected document");
  expect(result.pages[0]?.html).toMatch(
    /^<p><img src="data:image\/png;base64,[^"]+" alt="Logo Research &amp; &quot;Design&quot;">Visible caption<\/p>$/,
  );
});

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

it("shows notebook error outputs saved without a traceback", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      nbformat: 4,
      cells: [
        {
          cell_type: "code",
          source: "",
          outputs: [
            {
              output_type: "error",
              ename: "ZeroDivisionError",
              evalue: "division by zero",
              traceback: [],
            },
            {
              output_type: "error",
              evalue: "\u001b[31mbad input\u001b[0m",
              traceback: [],
            },
            {
              output_type: "error",
              ename: "RuntimeError",
              evalue: "kernel reset",
              traceback: ["\u001b[31m\u001b[0m", "  \n"],
            },
          ],
        },
      ],
    }),
  );
  const result = openNotebook(bytes.buffer as ArrayBuffer);
  if (result.type !== "notebook") throw new Error("Expected notebook");
  expect(result.cells[0]?.outputs).toEqual([
    { kind: "text", text: "ZeroDivisionError: division by zero" },
    { kind: "text", text: "bad input" },
    { kind: "text", text: "RuntimeError: kernel reset" },
  ]);
});

const html = (rtf: string) => {
  const result = openRtf(new TextEncoder().encode(rtf).buffer as ArrayBuffer);
  if (result.type !== "document") throw new Error("Expected document");
  return result.pages.map((page) => page.html);
};

describe("rich text preview paragraphs", () => {
  it("honors hidden character formatting and its reset", () => {
    expect(
      html(String.raw`{\rtf1 A{\v hidden{\v0 B}hidden}C\v hidden\v0 D\v hidden\plain E}`),
    ).toEqual(["<p>ABCDE</p>"]);
    expect(html(String.raw`{\rtf1\ansi{\v\line\line\line}First line\line Second line}`)).toEqual([
      "<p>First line<br>Second line</p>",
    ]);
  });
  it("renders TextEdit soft line breaks while hiding deleted breaks", () => {
    const expected = html(String.raw`{\rtf1\ansi First line\line Second line}`);
    expect(html(String.raw`{\rtf1\ansi First line\uc0\u8232 Second line}`)).toEqual(expected);
    expect(html(String.raw`{\rtf1\ansi First line\u8232?Second line{\deleted\u8232?}}`)).toEqual(
      expected,
    );
  });
  it("starts a new line at section and column breaks without duplicate breaks", () => {
    expect(
      html(
        String.raw`{\rtf1\ansi\sectd\cols2\pard North\column South\page East\sect\sectd\pard West\par}`,
      ),
    ).toEqual(["<p>North<br>South</p>", "<p>East<br>West<br></p>"]);
    expect(
      html(String.raw`{\rtf1\ansi First\par\sect\sectd Second\par\column Third\page\sect Fourth}`),
    ).toEqual(["<p>First<br>Second<br>Third</p>", "<p>Fourth</p>"]);
  });
  it("hides tracked deletions while retaining replacement text", () => {
    expect(html(String.raw`{\rtf1 aaa{\deleted bbb}{\revised BBB}ccc}`)).toEqual([
      "<p>aaaBBBccc</p>",
    ]);
    expect(html(String.raw`{\rtf1 A\deleted old\deleted0 B\deleted old\plain C}`)).toEqual([
      "<p>ABC</p>",
    ]);
    expect(html(String.raw`{\rtf1 A{\deleted\uc1\u945\deleted0 old}B}`)).toEqual(["<p>AB</p>"]);
  });
  it("decodes Mac Roman rich text", () => {
    for (const header of [String.raw`\mac`, String.raw`\mac\ansicpg10000`]) {
      expect(html(String.raw`{\rtf1` + header + String.raw` Caf\'8e Cr\'8fme}`)).toEqual([
        "<p>Café Crème</p>",
      ]);
    }
  });
  it("decodes rich text code pages 0 and 866", () => {
    for (const [rtf, expected] of [
      [String.raw`{\rtf1\ansi\ansicpg0 Caf\'e9}`, "<p>Café</p>"],
      [String.raw`{\rtf1\ansi\ansicpg866 \'8f\'e0\'a8\'a2\'a5\'e2}`, "<p>Привет</p>"],
      [
        String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl\f0\froman\fcharset0 Times-Roman;}\f0 \'805 caf\'e9}`,
        "<p>€5 café</p>",
      ],
      [
        String.raw`{\rtf1\mac\ansicpg10000{\fonttbl\f0\fnil\fcharset0 LucidaGrande;}\f0 pridr\'9eana}`,
        "<p>pridržana</p>",
      ],
      [
        String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl{\f0\fnil\fcharset0\cpg1251 Arial;}{\f1\fnil\fcharset204 Arial{\*\fontfile\cpg1252 arial.ttf};}}\f0 \'cf\'f0\'e8\f1\'e2\'e5\'f2}`,
        "<p>Привет</p>",
      ],
    ] as const) {
      expect(html(rtf)).toEqual([expected]);
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
