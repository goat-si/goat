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
