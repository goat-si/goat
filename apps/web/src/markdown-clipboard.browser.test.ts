import { describe, expect, it } from "vite-plus/test";
import { chatMarkdownClipboardPayload, restorePastedMarkdownLinks } from "./markdown-clipboard";

it("copies items within a list with their visible markers", () => {
  const root = document.createElement("div");
  root.innerHTML = "<ol><li>Install</li><li>Configure</li><li>Deploy</li></ol>";
  document.body.append(root);
  try {
    const items = root.querySelectorAll("li");
    const range = document.createRange();
    range.setStart(items[1]!.firstChild!, 0);
    range.setEnd(items[2]!.firstChild!, "Deploy".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe("2. Configure\n3. Deploy");
    selection.removeAllRanges();
  } finally {
    root.remove();
  }
});

describe("restoring pasted Markdown links", () => {
  it.each([
    {
      case: "repeated labels with distinct destinations",
      plain: "Guide: Guide, Guide.",
      html: '<p>Guide: <a href="https://example.com/start">Guide</a>, <a href="https://example.com/end">Guide</a>.</p>',
      expected: "Guide: [Guide](https://example.com/start), [Guide](https://example.com/end).",
    },
    {
      case: "line breaks within a link",
      plain: "First\nSecond",
      html: '<a href="https://example.com/">First<br>Second</a>',
      expected: "[First](https://example.com/)\n[Second](https://example.com/)",
    },
    {
      case: "a backslash immediately before a link",
      plain: "\\Guide",
      html: '\\<a href="https://example.com/">Guide</a>',
      expected: "\\\\[Guide](https://example.com/)",
    },
    {
      case: "nested labels, punctuation and native clipboard line breaks",
      plain: "First line\n\nRead [the guide] & notes",
      html: '<p>First line</p><p>Read <a href="https://example.com/guide(part)?a=1&amp;b=2"><strong>[the guide]</strong></a> &amp; notes</p>',
      expected:
        "First line\n\nRead [\\[the guide\\]](https://example.com/guide\\(part\\)?a=1&amp;b=2) & notes",
    },
    {
      case: "visible labels surrounded by hidden content",
      plain: "Read the guide.",
      html: '<span hidden>Skip</span>Read <a href="https://example.com/guide">the <span style="display: none">hidden </span>guide</a>.',
      expected: "Read [the guide](https://example.com/guide).",
    },
    {
      case: "visible link overrides inside a hidden ancestor",
      plain: "Guide",
      html: '<span style="visibility:hidden">Skip <a style="visibility:visible" href="https://example.com/"><span style="display:none;visibility:visible">Skip </span>Guide</a></span>',
      expected: "[Guide](https://example.com/)",
    },
    {
      case: "destinations without an external link scheme and anchors with no label",
      plain: "Local, unavailable, and !Guide",
      html: '<a href="/local">Local</a>, <a>unavailable</a>, and !<a href="https://example.com/guide">Guide</a><a href="https://example.com/empty"></a>',
      expected: "Local, unavailable, and \\![Guide](https://example.com/guide)",
    },
    {
      case: "linked identifiers inside code samples as code",
      plain: "pub fn new(v: Vec<u8>) -> Self",
      html: '<pre><code>pub fn new(v: <a href="https://doc.rust-lang.org/std/vec/struct.Vec.html">Vec</a>&lt;<a href="https://doc.rust-lang.org/std/primitive.u8.html">u8</a>&gt;) -&gt; Self</code></pre>',
      expected: "pub fn new(v: Vec<u8>) -> Self",
    },
  ])("keeps $case", ({ plain, html, expected }) => {
    expect(restorePastedMarkdownLinks(plain, html)).toBe(expected);
  });

  it("escapes literal entity names in the destination", () => {
    const text = restorePastedMarkdownLinks(
      "Guide",
      '<a href="https://example.com/?q=&amp;copy;">Guide</a>',
    );
    expect(text).toBe("[Guide](https://example.com/?q=&amp;copy;)");
  });
});
