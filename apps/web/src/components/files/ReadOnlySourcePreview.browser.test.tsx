import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";

import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

// The pool starts its workers before showing any code, which can outlast a cold CI browser.
vi.mock(import("~/components/DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import ReadOnlySourcePreview from "./ReadOnlySourcePreview";

const LINE_COUNT = 301;
const text = `${Array.from({ length: LINE_COUNT }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

// The browser ignores a copy event's data unless the event is cancelled, and copies the selection itself.
function copiedText(target: Element) {
  const clipboardData = new DataTransfer();
  const handled = !target.dispatchEvent(
    new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true, composed: true }),
  );
  return handled ? clipboardData.getData("text/plain") : null;
}

describe("ReadOnlySourcePreview", () => {
  it("copies the whole file after Select All, wherever the preview is scrolled", async () => {
    // File paints nothing until the shared highlighter has loaded; once it has, mount renders synchronously.
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));
    // Only rows near the viewport are mounted, so the browser's own copy would stop there.
    expect(rows().length).toBeLessThan(LINE_COUNT);

    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    const scroller = screen.container.querySelector(".file-preview-virtualizer")!;
    scroller.scrollTop = scroller.scrollHeight;
    await vi.waitFor(() => expect(rows()[0]?.textContent).not.toBe("line 1"));
    expect(copiedText(rows()[0]!)).toBe(text);

    document.getSelection()!.removeAllRanges();
    await userEvent.click(rows()[rows().length - 1]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    // A selection that stops inside the mounted rows at either end stays the browser's to copy.
    const pre = root.querySelector("pre")!;
    const firstText = rows()[0]!.querySelector("span")!.firstChild!;
    const lastText = rows()[rows().length - 1]!.querySelector("span")!.firstChild!;
    document.getSelection()!.setBaseAndExtent(pre, 0, lastText, 4);
    expect(copiedText(rows()[0]!)).toBeNull();
    document.getSelection()!.setBaseAndExtent(firstText, 4, pre, pre.childNodes.length);
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  it("copies the whole file after Select All in a browser without composed ranges", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Selection.prototype, "getComposedRanges");
    Object.defineProperty(Selection.prototype, "getComposedRanges", {
      value: undefined,
      configurable: true,
    });
    using _restore = {
      [Symbol.dispose]: () => {
        if (descriptor) Object.defineProperty(Selection.prototype, "getComposedRanges", descriptor);
      },
    };
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(
      <div className="flex h-[400px] flex-col">
        <ReadOnlySourcePreview name="notes.txt" text={text} wordWrap={false} />
      </div>,
    );
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toBe("line 1"));

    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    // A click after Select All starts a selection of the user's own, which the browser copies.
    await userEvent.click(rows()[1]!);
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  function stubComposedRanges(value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(Selection.prototype, "getComposedRanges");
    Object.defineProperty(Selection.prototype, "getComposedRanges", { value, configurable: true });
    return {
      [Symbol.dispose]: () => {
        if (descriptor) Object.defineProperty(Selection.prototype, "getComposedRanges", descriptor);
      },
    };
  }

  const preview = (name: string, contents: string) => (
    <div className="flex h-[400px] flex-col">
      <ReadOnlySourcePreview name={name} text={contents} wordWrap={false} />
    </div>
  );

  async function selectAll(screen: { container: HTMLElement }) {
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const rows = () => root.querySelectorAll("[data-line]");
    await vi.waitFor(() => expect(rows()[0]?.textContent).toMatch(/^line 1|^other 1/));
    await userEvent.click(rows()[0]!);
    await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
    return rows;
  }

  it("keeps a remembered Select All only across the copy shortcut", async () => {
    using _stub = stubComposedRanges(undefined);
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(preview("notes.txt", text));
    const rows = await selectAll(screen);
    await userEvent.keyboard("{ControlOrMeta>}c{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBe(text);

    // Shrinking the selection from the keyboard leaves the visible selection to the browser.
    await userEvent.keyboard("{ControlOrMeta>}{Shift>}{ArrowUp}{/Shift}{/ControlOrMeta}");
    expect(copiedText(rows()[0]!)).toBeNull();
  });

  it("drops a remembered Select All when the preview shows another file", async () => {
    using _stub = stubComposedRanges(undefined);
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(preview("notes.txt", text));
    await selectAll(screen);
    const other = `${Array.from({ length: 5 }, (_, index) => `other ${index + 1}`).join("\n")}\n`;
    await screen.rerender(preview("other.txt", other));
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    await vi.waitFor(() => expect(root.querySelector("[data-line]")?.textContent).toBe("other 1"));
    expect(copiedText(root.querySelector("[data-line]")!)).toBeNull();
  });

  it("falls back to the remembered Select All where composed ranges reject their argument", async () => {
    using _stub = stubComposedRanges(function (this: Selection, options?: unknown) {
      if (options !== undefined) throw new TypeError("shadow root list expected");
      return [];
    });
    await getSyntaxHighlighterPromise("text");
    await using screen = await render(preview("notes.txt", text));
    const rows = await selectAll(screen);
    expect(copiedText(rows()[0]!)).toBe(text);
  });
});
