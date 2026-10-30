/** Notes that cover what the visual editor must keep byte for byte, or refuse to open. */
export const VISUAL_NOTE_FIXTURES = {
  headings:
    "# Title\n\n## Section\n\nPlain **bold**, *italic*, ~~gone~~ and [a link](https://example.com).\n",
  nestedList3: "- one\n   - nested\n      - deeper\n- two\n\n1. first\n2. second\n",
  nestedList2: "- one\n  - nested\n- two\n",
  nestedList4: "- one\n    - nested\n- two\n",
  checklist: "- [ ] open task\n- [x] done task\n",
  codeFence: "Before\n\n```ts\nconst x = 1;\n```\n",
  table: "| a | b |\n| - | - |\n| 1 | 2 |\n",
  quote: "> quoted line\n",
  html: "<details>\n<summary>More</summary>\n</details>\n",
  referenceLink: "See [docs][1].\n\n[1]: https://example.com\n",
  footnote: "Claim.[^1]\n\n[^1]: Source.\n",
  frontmatter: "---\ntags: [a]\n---\n# Body\n",
  korean: "# 회의 메모\n\n**중요**: 한글과 이모지 🎉 를 섞은 문장.\n\n- 첫째\n- 둘째\n",
  crlf: "# Title\r\n\r\nFirst line\r\nSecond line\r\n",
  mixedEndings: "one\r\ntwo\n",
  noTrailingNewline: "# Title\n\nNo newline at the end",
} as const;
