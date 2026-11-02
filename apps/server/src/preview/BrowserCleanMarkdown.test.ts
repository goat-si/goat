import { describe, expect, it } from "@effect/vitest";

import { extractCleanMarkdown } from "./BrowserCleanMarkdown.ts";

describe("extractCleanMarkdown", () => {
  it("omits document metadata, hidden content, scripts, and form values", () => {
    const html = `<head><title>secret-title</title></head><p>visible</p>
      <script>secret-script</script><style>secret-style</style><noscript>secret-noscript</noscript>
      <svg><text>secret-svg</text></svg><template>secret-template</template>
      <div hidden>secret-hidden</div><div aria-hidden="true">secret-aria</div>
      <div style="display: none">secret-display</div><div style="visibility:hidden">secret-visibility</div>
      <div inert>secret-inert</div><input value="secret-input"><textarea>secret-textarea</textarea>
      <select><option>secret-option</option></select>`;
    const { markdown } = extractCleanMarkdown(html);
    expect(markdown).toBe("visible");
    expect(markdown).not.toContain("secret-");
  });

  it("does not treat a script-like closing tag as the end of a script", () => {
    const { markdown } = extractCleanMarkdown(
      "<script>secret-one</scriptx>secret-two</script><p>visible</p>",
    );
    expect(markdown).toBe("visible");
  });

  it("accepts a greater-than sign inside a quoted attribute", () => {
    const { markdown } = extractCleanMarkdown('<p title="one > two">visible</p>');
    expect(markdown).toBe("visible");
  });

  it("renders headings and paragraphs with a single blank line between blocks", () => {
    const { markdown } = extractCleanMarkdown("<h1>Title</h1><p>First</p><p>Second</p>");
    expect(markdown).toBe("# Title\n\nFirst\n\nSecond");
  });

  it("preserves nested list indentation and ordered list start numbers", () => {
    const { markdown } = extractCleanMarkdown(
      '<ol start="3"><li>one<ul><li>inner</li></ul></li><li>two</li></ol>',
    );
    expect(markdown.split("\n")).toContain("3. one");
    expect(markdown.split("\n")).toContain("   - inner");
    expect(markdown.split("\n")).toContain("4. two");
  });

  it("renders blockquotes and inline emphasis and code", () => {
    const { markdown } = extractCleanMarkdown(
      "<blockquote><p><strong>bold</strong> <em>italic</em> <code>code</code></p></blockquote>",
    );
    expect(markdown).toBe("> **bold** *italic* `code`");
  });

  it("preserves blank lines, decoded entities, and long JSON inside fenced preformatted text", () => {
    const json = JSON.stringify({ message: "x".repeat(150) });
    const { markdown } = extractCleanMarkdown(`<pre>first &amp; second\n\n${json}\nlast</pre>`);
    expect(markdown).toBe(`\`\`\`\nfirst & second\n\n${json}\nlast\n\`\`\``);
  });

  it("keeps every line of a preformatted block inside its list item or blockquote", () => {
    const listed = extractCleanMarkdown("<ol start=3><li>one<pre>alpha\n\nbeta</pre></li></ol>");
    expect(listed.markdown.split("\n")).toEqual([
      "3. one",
      "   ```",
      "   alpha",
      "",
      "   beta",
      "   ```",
    ]);
    const quoted = extractCleanMarkdown("<blockquote><pre>x = 1\ny = 2</pre></blockquote>");
    expect(quoted.markdown).toBe("> ```\n> x = 1\n> y = 2\n> ```");
  });

  it("filters long JSON outside preformatted text and counts the removed characters", () => {
    const json = JSON.stringify({ message: "x".repeat(150) });
    const { markdown, stats } = extractCleanMarkdown(`<p>before</p><p>${json}</p><p>after</p>`);
    expect(markdown).toContain("before");
    expect(markdown).toContain("after");
    expect(markdown).not.toContain(json);
    expect(stats.filteredCharsRemoved).toBeGreaterThanOrEqual(json.length);
    expect(stats.initialMarkdownChars - stats.filteredCharsRemoved).toBe(markdown.length);
  });

  it("renders table headers, separators, escaped pipes, and colspan", () => {
    const { markdown } = extractCleanMarkdown(
      "<table><tr><th>A</th><th>B</th></tr><tr><td>left|right</td><td>value</td></tr><tr><td colspan=2>wide</td></tr></table>",
    );
    expect(markdown).toContain("| A | B |\n| --- | --- |");
    expect(markdown).toContain("| left\\|right | value |");
    expect(markdown).toContain("| wide |  |");
  });

  it("adds a separator and retains data for a table without header cells", () => {
    const { markdown } = extractCleanMarkdown("<table><tr><td>one</td><td>two</td></tr></table>");
    expect(markdown).toContain("| --- | --- |");
    expect(markdown).toContain("| one | two |");
  });

  it("renders links as text by default and safely emits requested links", () => {
    const html =
      '<a href="https://example.com/path?token=abc">label]</a> ' +
      '<a href="javascript:alert(1)">js</a> <a href="data:text/plain,hi">data</a> ' +
      '<a href="java&#x0A;script:alert(1)">obfuscated</a>';
    expect(extractCleanMarkdown(html).markdown).toBe("label] js data obfuscated");
    const { markdown } = extractCleanMarkdown(html, { extractLinks: true });
    expect(markdown).toContain("[label\\]](https://example.com/path?token=redacted)");
    expect(markdown).toContain("js data obfuscated");
    expect(markdown).not.toContain("javascript:");
    expect(markdown).not.toContain("data:text");
    expect(markdown).not.toContain("token=abc");
  });

  it("renders images as alt text by default and emits only safe requested image URLs", () => {
    const html =
      '<img alt="picture" src="https://example.com/image.png"><img alt="unsafe" src="data:image/png;base64,AAAA">';
    expect(extractCleanMarkdown(html).markdown).toBe("pictureunsafe");
    const { markdown } = extractCleanMarkdown(html, { extractImages: true });
    expect(markdown).toContain("![picture](https://example.com/image.png)");
    expect(markdown).toContain("unsafe");
    expect(markdown).not.toContain("data:image");
  });

  it("recovers sensible text and entities from malformed and uppercase HTML", () => {
    const html =
      "</div><P>First &amp; &#x41; &nbsp; text<P>Second<UL><LI>one<LI>two</UL><TABLE><TR><TD>left<TD>right</TABLE>";
    const { markdown } = extractCleanMarkdown(html);
    expect(markdown).toMatch(/First & A\s+text/);
    expect(markdown).toContain("Second");
    expect(markdown).toContain("- one");
    expect(markdown).toContain("- two");
    expect(markdown).toContain("| left | right |");
  });

  it("collapses excess blank lines and reports consistent character statistics", () => {
    const html = "<p>first</p><p></p><p></p><p>second</p>";
    const { markdown, stats } = extractCleanMarkdown(html);
    expect(markdown).toBe("first\n\nsecond");
    expect(stats.originalHtmlChars).toBe(html.length);
    expect(stats.finalMarkdownChars).toBe(markdown.length);
    expect(stats.initialMarkdownChars - stats.filteredCharsRemoved).toBe(stats.finalMarkdownChars);
    expect(stats.truncated).toBe(false);
  });

  it("respects character limits without splitting emoji and leaves non-finite limits unlimited", () => {
    const html = "<p>abc😀def</p>";
    const limited = extractCleanMarkdown(html, { maxChars: 4 });
    expect(limited.markdown.length).toBeLessThanOrEqual(4);
    expect(limited.markdown).toBe("abc");
    expect(limited.stats.truncated).toBe(true);
    expect(limited.stats.finalMarkdownChars).toBe(limited.markdown.length);
    expect(extractCleanMarkdown(html).stats.truncated).toBe(false);
    expect(extractCleanMarkdown(html, { maxChars: Infinity }).stats.truncated).toBe(false);
    expect(extractCleanMarkdown(html, { maxChars: Infinity }).markdown).toBe("abc😀def");
  });

  it("returns without overflowing on deeply nested HTML and reports truncation", () => {
    const html = "<div>".repeat(5000) + "deep" + "</div>".repeat(5000);
    const result = extractCleanMarkdown(html);
    expect(result.stats.truncated).toBe(true);
    expect(result.stats.originalHtmlChars).toBe(html.length);
  });
});
