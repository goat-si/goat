// Notes that exercise markdown the editor must carry through untouched.
export const noteSourceFixtures: Readonly<Record<string, string>> = {
  headings: "# Title\n\n## Second ##\n###### Sixth\n#not a heading\n",
  nestedListsTwoSpaces: "- one\n  - two\n    - three\n- four\n",
  nestedListsFourSpaces: "1. one\n    1. two\n        - three\n2) four",
  taskList: "- [ ] open task\n- [x] done task\n  - [X] nested done\n* [ ]\n",
  codeFence:
    "Before\n\n~~~ts\nconst a = **not bold**;\n~~~\n\n```\nnested `` ticks\n````\nunclosed?\n```\n",
  table:
    "| Name | Value |\n| :--- | ---: |\n| a \\| b | `x|y` |\n| **bold** | [link](https://goat.si) |\n\nAfter\n",
  blockquote: "> quote\n> > nested **quote**\n>\n> - list in quote\n",
  html: "<details>\n<summary>More</summary>\n\n*inside*\n\n</details>\n<!-- hidden -->\n<br/>\n",
  referenceLinks: 'See [the docs][docs] and [docs].\n\n[docs]: https://goat.si/docs "Docs"\n',
  footnotes: "A claim.[^1]\n\n[^1]: The **source**.\n",
  frontmatterLike: "---\ntitle: Kept\ntags: [a, b]\n---\nBody\n",
  hangulEmoji: "# 한글 제목 😀\n\n**굵은 한글** 그리고 _기울임_ 👩‍👩‍👧 가족\n- [ ] 할 일 ✅\n",
  crlf: "# Title\r\n\r\n- [ ] task\r\n**bold**\r\n",
  mixedLineEndings: "first\r\nsecond\nthird\r\n",
  noTrailingNewline: "Last line without newline **bold**",
  trailingBlankLines: "Text\n\n\n",
  escapes: "\\*not italic\\* and snake_case_name and 2*3*4\n",
  links: "<https://goat.si> and https://goat.si/path?x=1, ![alt](img.png) [a [nested] b](u)\n",
  thematicBreak: "Above\n\n---\n\n* * *\nBelow\n",
  empty: "",
};

export const noteFallbackFixtures: Readonly<Record<string, string>> = {
  nul: "before\0after\n",
  loneCarriageReturn: "old\rmac\r",
  loneSurrogate: "broken \uD83D text\n",
};
