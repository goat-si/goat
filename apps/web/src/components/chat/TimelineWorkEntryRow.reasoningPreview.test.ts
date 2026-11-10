import { parseMarkdownWithMath } from "@goat/shared/markdownMath";
import { describe, expect, it } from "vite-plus/test";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";

describe("compact reasoning math", () => {
  it.each([
    [
      "## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]",
      [
        ["text", "Reasoning Use norm "],
        ["inlineMath", "|x|"],
        ["text", " and "],
        ["inlineMath", "x^2"],
      ],
    ],
    [
      "  Lead   **bold**\n\n   *em*  `code`  \n\n- one\n-   two\n\n> quote\n> more\n\ntrail   ",
      [["text", "Lead bold em code one two quote more trail"]],
    ],
    [
      "$a$ starts, ends with $b$",
      [
        ["inlineMath", "a"],
        ["text", " starts, ends with "],
        ["inlineMath", "b"],
      ],
    ],
    [
      "before   $x$\n\n$$\ny\n$$\n\n   after",
      [
        ["text", "before "],
        ["inlineMath", "x"],
        ["text", " "],
        ["inlineMath", "y"],
        ["text", " after"],
      ],
    ],
    [
      "a *b*$c$**d** e",
      [
        ["text", "a b"],
        ["inlineMath", "c"],
        ["text", "d e"],
      ],
    ],
    [
      "$a$![](x.png)$b$",
      [
        ["inlineMath", "a"],
        ["text", ""],
        ["inlineMath", "b"],
      ],
    ],
    [
      "| a | b |\n| - | - |\n| $x$ | y  z |",
      [
        ["text", "a b "],
        ["inlineMath", "x"],
        ["text", " y z"],
      ],
    ],
    [
      'See [a  link](https://example.com "t") ![alt   text](img.png) <b>bold</b> <!-- c -->\n\n[ref]: https://example.com\n\n:::note\nbody\n:::',
      [["text", "See a link alt text bold :::note body :::"]],
    ],
    [
      "line one\r\nline two\r\n\r\nnext  nbsp　wide 😀𝑥 end",
      [["text", "line one line two next nbsp wide 😀𝑥 end"]],
    ],
    ["\\$5 and \\$6, \\*not em\\*", [["text", "$5 and $6, *not em*"]]],
    ["hard  \nbreak\\\nagain", [["text", "hard break again"]]],
    ["<div>only html</div>", [["text", "Reasoning"]]],
  ])("keeps formulas while flattening compact reasoning previews: %j", (source, expected) => {
    const tree = parseMarkdownWithMath(source);
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => [node.type, "value" in node ? node.value : null])).toEqual(
      expected,
    );
  });
});
