export const documentAlternateContentFixtures = [
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
    },
    expected: ["Body\nCallout box\nSecond line"],
    occurrences: { text: "Callout box", count: 1 },
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
    },
    expected: ["Chart caption"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:del><w:r><w:delText>Deleted text</w:delText></w:r></w:del><w:r><w:instrText>HIDDEN FIELD</w:instrText></w:r></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Visible fallback caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
    },
    expected: ["Visible fallback caption"],
    absent: ["Deleted text", "HIDDEN FIELD"],
  },
] as const;

export const documentHiddenTextFixtures = [
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t> 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Fee </w:t></w:r><w:del><w:r><w:delText>$500</w:delText><w:noBreakHyphen/></w:r></w:del><w:ins><w:r><w:t>$700</w:t></w:r></w:ins><w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom><w:r><w:tab/><w:t>due</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["Intro 3\nFee $700\tdue"],
    absent: ["PAGEREF", "$500", "Moved", "\u2011"],
  },
  {
    ext: "odt",
    bounded: true,
    parts: {
      "content.xml":
        "<document><text><tracked-changes><changed-region><deletion><change-info><creator>Reviewer</creator></change-info><p>$500</p></deletion></changed-region></tracked-changes><p>Fee <change/>$700</p></text></document>",
    },
    expected: ["Fee $700"],
    absent: ["Reviewer", "$500"],
  },
  {
    ext: "odt",
    bounded: true,
    parts: {
      "content.xml":
        '<document><text><p>Fee <office:annotation><dc:creator>Reviewer</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><initials>JR</initials><p>Check</p></office:annotation>$700</p><table><table-row><table-cell office:value-type="float" office:value="150"><office:annotation><p>was 120</p></office:annotation></table-cell></table-row></table><p>Formula <math:math><math:semantics><math:mrow>x+y</math:mrow><math:annotation encoding="application/x-tex">x+y</math:annotation></math:semantics></math:math></p></text></document>',
    },
    expected: ["Fee $700\n150\nFormula x+yx+y"],
    absent: ["Reviewer", "2026-01-01", "JR", "Check", "was 120"],
  },
] as const;

export const documentLineBreakFixtures = [
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>First</w:t><w:cr/><w:t>Second</w:t><w:br/><w:t>Third</w:t><w:noBreakHyphen/><w:t>party</w:t><mc:AlternateContent xmlns:mc="urn:mc"><mc:Choice Requires="w"><w:noBreakHyphen/></mc:Choice><mc:Fallback><w:t>‑</w:t></mc:Fallback></mc:AlternateContent><w:t>End</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["First\nSecond\nThird\u2011party\u2011End"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml": [
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body>',
        '<w:p><w:r><w:t>Invoice 104</w:t><w:ptab w:alignment="right"/><w:t>$700.00</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Invoice 105</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:ptab w:alignment="right"/></mc:Choice><mc:Fallback><w:tab/></mc:Fallback></mc:AlternateContent><w:t>$800.00</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Invoice 106</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:ptab w:alignment="right"/></mc:Choice><mc:Fallback><w:t xml:space="preserve"> total </w:t></mc:Fallback></mc:AlternateContent><w:t>$900.00</w:t></w:r></w:p>',
        "</w:body></w:document>",
      ].join(""),
    },
    expected: ["Invoice 104\t$700.00\nInvoice 105\t$800.00\nInvoice 106 total $900.00"],
  },
] as const;

export const documentRtfCases = [
  [
    "page-specific headers and footers",
    String.raw`{\rtf1\ansi\facingp\sectd\titlepg
{\headerf First-page header}{\headerl Left-page header}{\headerr Right-page header}
{\footerf First-page footer}{\footerl Left-page footer}{\footerr Right-page footer}
\pard Approved delivery date: 24 November.\par
}`,
    "Approved delivery date: 24 November.",
  ],
  [
    "text symbols",
    String.raw`{\rtf1\ansi Pages 1\endash 5\emdash\lquote left\rquote\ldblquote right\rdblquote\bullet\b End\b0\unknown{\*\secret\bullet hidden}}`,
    // oxlint-disable-next-line goat/no-em-dash-copy -- This fixture checks RTF symbol decoding.
    "Pages 1–5\u2014‘left’“right”•End",
  ],
  [
    "space and hyphen symbols",
    String.raw`{\rtf1\ansi A\enspace B\emspace C\qmspace D\~E\_F\-G}`,
    "A\u2002B\u2003C\u2005D\u00a0E\u2011FG",
  ],
  [
    "joiner and direction marks",
    String.raw`{\rtf1\ansi A\zwj B\zwnj C\ltrmark D\rtlmark E}`,
    "A\u200dB\u200cC\u200eD\u200fE",
  ],
  [
    "text symbol fallback",
    String.raw`{\rtf1\ansi\uc10\u945\endash\emdash\enspace\emspace\qmspace\lquote\rquote\ldblquote\rdblquote\bullet Z}`,
    "αZ",
  ],
  ["hyphen symbol fallback", String.raw`{\rtf1\ansi\uc3\u945\~\_\-Z}`, "αZ"],
  ["control word", String.raw`{\rtf1\ansi A\u9\tab X}`, "A\tX"],
  ["line break paragraphs", "{\\rtf1\\ansi First\\\nSecond\\\r\nThird}", "First\nSecond\nThird"],
  [
    "tracked deletion",
    String.raw`{\rtf1\ansi The fee is {\deleted\revauthdel1\revdttmdel1 $500}{\revised\revauth1 $700}.}`,
    "The fee is $700.",
  ],
  [
    "tracked deletion end",
    String.raw`{\rtf1\ansi{\header Header\plain Plain}A\deleted B\deleted0 C\deleted D\plain E}`,
    "ACE",
  ],
  [
    "tracked deletion fallback",
    String.raw`{\rtf1\ansi A{\deleted\uc1\u945\deleted0 B}\deleted\u946?\deleted0 C}`,
    "AC",
  ],
  [
    "tracked deletion table",
    String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000\intbl A\deleted\cell\deleted0 B\cell\deleted\row\deleted0 C\cell}`,
    "A\tB\t\nC",
  ],
  ["hidden text", String.raw`{\rtf1\ansi A {\v B{\v0 C}D} E\v F\v0  G\v1 H\plain  I}`, "A C E G I"],
  [
    "hidden text table and escapes",
    String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000\intbl A\v B\u945?\'e9\cell\v0 C\cell\v\row\v0 D\cell}`,
    "A\tC\t\nD",
  ],
  [
    "document breaks",
    String.raw`{\rtf1\ansi\sectd\cols2\pard North quota: 120\column South quota: 240\page East quota: 360\sect\sectd\pard West quota: 480\par}`,
    "North quota: 120\nSouth quota: 240\nEast quota: 360\nWest quota: 480",
  ],
  ["group close", String.raw`{\rtf1\ansi{\u945}Z}`, "αZ"],
  ["group open", String.raw`{\rtf1\ansi\u945{Z}}`, "αZ"],
  ["hex byte", String.raw`{\rtf1\ansi\u945\'3fZ}`, "αZ"],
  ["escaped symbol", String.raw`{\rtf1\ansi\u945\{Z}`, "αZ"],
  ["Macintosh text", String.raw`{\rtf1\mac Caf\'8e Cr\'8fme}`, "Café Crème"],
  [
    "explicit Macintosh code page",
    String.raw`{\rtf1\mac\ansicpg10000 Caf\'8e Cr\'8fme}`,
    "Café Crème",
  ],
  [
    "font character set",
    String.raw`{\rtf1\ansi\ansicpg1252\deff1{\fonttbl\f0\fnil\fcharset178 GeezaPro;\f1\fnil\fcharset0 LucidaGrande;}
\f0 \'e3\'e1\'c7\'cd\'d9\'c9\f1 : caf\'e9, \f0\plain\'c7a}`,
    "ملاحظة: café, Ça",
  ],
  [
    "font character set outside the font table",
    String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset178 A;}{\f0\fcharset0 B;}{\f1\fcharset0 C;}{\f2\fcharset178 D;}{\f2 E;}}{\stylesheet{\s0\f1\fcharset178 N;}}\f0 \'e3\f1\'e3\f2\'e3}`,
    "ããã",
  ],
  ["destination symbol", String.raw`{\rtf1\ansi\u945\*Z}`, "αZ"],
  ["multiple units", String.raw`{\rtf1\ansi\uc4\u945?\tab\'3f\~Z}`, "αZ"],
  ["binary unit", String.raw`{\rtf1\ansi\u945\bin3 abcZ}`, "αZ"],
  ["large fallback", String.raw`{\rtf1\ansi\uc20\u945????????????????????Z}`, "αZ"],
  ["no fallback", String.raw`{\rtf1\ansi\uc0\u945Z}`, "αZ"],
  ["scoped count", String.raw`{\rtf1\ansi{\uc2\u945??}\u946?Z}`, "αβZ"],
] as const;

export const documentMainPartFixtures = [
  ...["/word/../word/document2.xml", "word/document2.xml"].map((target) => ({
    ext: "docx",
    bounded: true,
    parts: {
      "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`,
      "word/document.xml": "<document><p>Stale draft</p></document>",
      "word/document2.xml": "<document><p>Launch moves to 3 March.</p></document>",
    },
    expected: ["Launch moves to 3 March."],
    absent: ["Stale draft", "[Skipped document part"],
  })),
  {
    ext: "docx",
    bounded: true,
    parts: {
      "_rels/.rels":
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/WORD/DOCUMENT.XML"/></Relationships>',
      "word/document.xml": "<document><p>Launch moves to 3 March.</p></document>",
    },
    expected: ["Launch moves to 3 March."],
    absent: ["[Skipped document part"],
  },
] as const;

export const documentEmptyNotesFixture = {
  ext: "pptx",
  bounded: true,
  parts: {
    "ppt/presentation.xml": '<presentation><sldIdLst><sldId r:id="a"/></sldIdLst></presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
    "ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
    "ppt/slides/_rels/a.xml.rels":
      '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/empty.xml"/></Relationships>',
    "ppt/notesSlides/empty.xml":
      '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:endParaRPr/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>57</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
  },
  expected: ["Slide text"],
  absent: ["Notes:", "57"],
} as const;

export const documentIndexFixture = {
  ext: "odt",
  parts: {
    "content.xml":
      '<office:document><text:h text:outline-level="2">\n  Orchard\n</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates <text:span>\n\t  shipped</text:span>   today<text:tab/>Dock<text:line-break/>Gate\u00a0B </text:p><text:p>Second</text:p><text:p>A<text:span><text:script>console.log(1);\n</text:script></text:span> B</text:p>' +
      [
        "table-of-content",
        "illustration-index",
        "table-index",
        "object-index",
        "user-index",
        "alphabetical-index",
        "bibliography",
      ]
        .map(
          (name) =>
            `<text:${name}><text:${name}-source><text:index-title-template>Contents</text:index-title-template><text:${name}-entry-template><text:index-entry-span>: </text:index-entry-span></text:${name}-entry-template></text:${name}-source><text:index-body><text:index-title><text:p>Contents</text:p></text:index-title><text:p>Orchard 1</text:p></text:index-body></text:${name}>`,
        )
        .join("") +
      "</office:document>",
  },
  expected: [
    `## Orchard\n19   violet crates shipped today\tDock\nGate\u00a0B\nSecond\nA B${"\nContents\nOrchard 1".repeat(7)}`,
  ],
} as const;
