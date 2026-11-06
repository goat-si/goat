export const documentAlternateContentFixtures = [
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
    },
    expected: ["Body\nCallout box"],
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
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t> 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Fee </w:t></w:r><w:del><w:r><w:delText>$500</w:delText></w:r></w:del><w:ins><w:r><w:t>$700</w:t></w:r></w:ins><w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom><w:r><w:tab/><w:t>due</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["Intro 3\nFee $700\tdue"],
    absent: ["PAGEREF", "$500", "Moved"],
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
] as const;

export const documentLineBreakFixtures = [
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>First</w:t><w:cr/><w:t>Second</w:t><w:br/><w:t>Third</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["First\nSecond\nThird"],
  },
] as const;
