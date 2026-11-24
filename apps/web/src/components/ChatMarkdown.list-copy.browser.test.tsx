import { describe, expect, it } from "vite-plus/test";
import { remarkEnableOrderedListNumbers } from "@goat/shared/markdownPipeline";
import { render } from "../../test/render";
import "../index.css";
import ChatMarkdown from "./ChatMarkdown";
import {
  chatMarkdownClipboardPayload,
  serializeRenderedMarkdownFragment,
} from "../markdown-clipboard";

const SOURCE_NUMBER_PLUGINS = [remarkEnableOrderedListNumbers];
function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}
describe("copy list selections", () => {
  it.each([
    {
      source: "10. First\n11. Second\n12. Third\n\nAfter.",
      from: "Second",
      text: "11. Second\n12. Third\n\nAfter.",
    },
    {
      source: "1. A\n2. B\n7. C\n8. D\n\nAfter.",
      from: "D",
      userMessage: true,
      text: "8. D\n\nAfter.",
    },
    {
      source: "1. Outer\n2. Next\n   1. Inner\n   2. Deeper\n\nAfter.",
      from: "Deeper",
      text: "2. 2. Deeper\n\nAfter.",
    },
    {
      source: "1. Install\n2. Configure\n3. Deploy",
      from: "Configure",
      to: "Deploy",
      text: "2. Configure\n3. Deploy",
    },
    {
      source: "1. A\n2. B\n7. C\n8. D",
      from: "B",
      to: "C",
      userMessage: true,
      text: "2. B\n7. C",
    },
    {
      source: "- Install\n- Configure\n- Deploy",
      from: "Configure",
      to: "Deploy",
      text: "- Configure\n- Deploy",
    },
  ])(
    "copies $text with the markers its list shows",
    async ({ source, from, to, userMessage, text }) => {
      await using screen = await renderText(
        source,
        userMessage ? { extraRemarkPlugins: SOURCE_NUMBER_PLUGINS } : {},
      );
      const itemText = (shown: string) =>
        [...screen.container.querySelectorAll("li")]
          .flatMap((item) => [...item.childNodes])
          .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent === shown)!;
      const end = to
        ? itemText(to)
        : [...screen.container.querySelectorAll("p")].at(-1)!.firstChild!;
      const range = document.createRange();
      range.setStart(itemText(from), 0);
      range.setEnd(end, end.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const payload = chatMarkdownClipboardPayload(selection);
      expect(payload?.text).toBe(text);
      // Rich paste reads back as the same list.
      expect(
        serializeRenderedMarkdownFragment(
          new DOMParser().parseFromString(payload!.html, "text/html").body,
        ),
      ).toBe(text);
    },
  );

  it.each([
    {
      source: "1. [ ] Install\n2. [x] Configure\n3. [ ] Test\n4. [x] Deploy",
      from: "Configure",
      to: "Deploy",
      text: "2. [x] Configure\n3. [ ] Test\n4. [x] Deploy",
      htmlText: "2. Configure\n3. Test\n4. Deploy",
    },
    {
      source:
        "1. First\n2. [x] Outer\n   1. [ ] Setup\n   2. [ ] Configure\n   3. [x] Deploy\n\nAfter.",
      from: "Configure",
      text: "2. [x] 2. [ ] Configure\n   3. [x] Deploy\n\nAfter.",
      htmlText: "2. 2. Configure\n   3. Deploy\n\nAfter.",
    },
  ])(
    "copies task items with the markers its list shows: $text",
    async ({ source, from, to, text, htmlText }) => {
      await using screen = await renderText(source);
      const itemText = (label: string) =>
        [...screen.container.querySelectorAll("li")]
          .flatMap((item) => [...item.childNodes])
          .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim() === label)!;
      const start = itemText(from);
      const end = to ? itemText(to) : screen.container.querySelector("p")!.firstChild!;
      const range = document.createRange();
      range.setStart(start, start.textContent!.indexOf(from));
      range.setEnd(end, end.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const payload = chatMarkdownClipboardPayload(selection);
      expect(payload?.text).toBe(text);
      // HTML sanitization strips form controls.
      expect(
        serializeRenderedMarkdownFragment(
          new DOMParser().parseFromString(payload!.html, "text/html").body,
        ),
      ).toBe(htmlText);
    },
  );

  it.each([
    {
      source: "1. First\n2. Second\n\nAfter.",
      from: "First",
      skipFrom: true,
      text: "2. Second\n\nAfter.",
      items: 1,
    },
    {
      source: "Before.\n\n1. First\n2. Second",
      from: "Before.",
      to: "Second",
      skipTo: true,
      text: "Before.\n\n1. First",
      items: 1,
    },
    {
      source: "1. Outer\n   1. Inner\n   2. Deeper\n2. Next",
      from: "Inner",
      to: "Next",
      skipFrom: true,
      text: "1. 2. Deeper\n2. Next",
      items: 3,
    },
    {
      source: "1. Outer\n   1. Inner\n2. Next",
      from: "Inner",
      to: "Next",
      skipFrom: true,
      text: "2. Next",
      items: 1,
    },
  ])(
    "omits edge items outside the selection when copying with the markers its list shows: $text",
    async ({ source, from, to, skipFrom, skipTo, text, items }) => {
      await using screen = await renderText(source);
      const textNode = (shown: string) => {
        const walker = document.createTreeWalker(screen.container, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent === shown) return node;
        }
        throw new Error(`Could not find text: ${shown}`);
      };
      const end = to ? textNode(to) : textNode("After.");
      const range = document.createRange();
      range.setStart(textNode(from), skipFrom ? from.length : 0);
      range.setEnd(end, skipTo ? 0 : end.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);

      const payload = chatMarkdownClipboardPayload(selection);
      expect(payload?.text).toBe(text);
      const pasted = new DOMParser().parseFromString(payload!.html, "text/html");
      expect(serializeRenderedMarkdownFragment(pasted.body)).toBe(text);
      expect(pasted.querySelectorAll("li")).toHaveLength(items);
    },
  );

  it("omits an end item whose selected edge sits inside its link", async () => {
    await using screen = await renderText(
      "1. Install\n2. Configure\n3. Deploy\n4. [Verify](https://example.com/verify)",
    );
    const items = [...screen.container.querySelectorAll("li")];
    const start = items.find((item) => item.textContent === "Configure")!.firstChild!;
    const end = items.at(-1)!.querySelector("a > span")!.lastChild!;
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const payload = chatMarkdownClipboardPayload(selection);
    expect(payload?.text).toBe("2. Configure\n3. Deploy");
    const pasted = new DOMParser().parseFromString(payload!.html, "text/html");
    expect(
      [...pasted.querySelectorAll('ol[start="2"] > li')].map((item) => item.textContent),
    ).toEqual(["Configure", "Deploy"]);
  });
});
