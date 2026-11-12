import { expect, it } from "vite-plus/test";
import { prepareSourceFileDocument, selectableSourceHtml } from "./source-file-document";

it("keeps source text literal and selectable in the Android document", () => {
  const source = prepareSourceFileDocument(
    "\n\tlead\r\n<script>alert(1)</script> &amp; > 😀\u00a0end\n",
  );
  const html = selectableSourceHtml(source.contents, {
    foreground: "#000000",
    selection: "#3366ff",
    fontSize: 14,
    rowHeight: 24,
    wordBreak: true,
  });
  expect(html).toContain('<span id="L1"></span>\n<span id="L2">\tlead</span>');
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; &gt; 😀");
  expect(html).not.toContain("<script>");
  expect(html).toContain("default-src 'none'");
});
