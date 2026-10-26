import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { BrowserDocumentFrame } from "../BrowserDocumentFrame";
import { PdfPageInput } from "./PdfToolbar";
import { isPdfFindShortcut } from "./pdfShortcuts";
import type { PDFDocumentProxy } from "./pdfEngine";

const { load, openLink } = vi.hoisted(() => ({ load: vi.fn(), openLink: vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => openLink }));
vi.mock("./pdfEngine", () => ({
  loadPdfDocument: load,
  loadPdfEngine: async () => ({
    TextLayer: class {
      textDivs: HTMLElement[] = [];
      textContentItemsStr: string[] = [];
      container: HTMLElement;
      constructor(options: {
        container: HTMLElement;
        textContentSource: { items: { str: string }[] };
      }) {
        this.container = options.container;
        this.textContentItemsStr = options.textContentSource.items.map((item) => item.str);
      }
      async render() {
        this.textDivs = this.textContentItemsStr.map((str, index) => {
          const span = document.createElement("span");
          span.textContent = str;
          span.style.top = `${560 + index * 160}px`;
          this.container.append(span);
          return span;
        });
      }
      cancel() {}
    },
  }),
}));

function makeDocument(firstPageText = ["Page 1 needle"]) {
  return {
    numPages: 30,
    loadingTask: { destroy: vi.fn(async () => {}) },
    getPage: vi.fn(async (number: number) => ({
      pageNumber: number,
      getViewport: () => ({
        width: 600,
        height: 800,
        convertToViewportPoint: (x: number, y: number) => [x, y],
      }),
      getAnnotations: async () =>
        number === 1
          ? [
              { subtype: "Link", rect: [20, 30, 40, 50], url: "https://example.com/" },
              { subtype: "Link", rect: [60, 30, 80, 50], dest: [29, { name: "Fit" }] },
              { subtype: "Link", rect: [90, 30, 100, 50], url: "javascript:alert(1)" },
            ]
          : [],
      getTextContent: async () => ({
        items: (number === 1
          ? firstPageText
          : [number === 30 ? `Page ${number} needle` : `Page ${number}`]
        ).map((str) => ({ str, hasEOL: true })),
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      cleanup: vi.fn(),
    })),
  } as unknown as PDFDocumentProxy;
}

let root: Root;
let host: HTMLDivElement;
const button = (label: string) => {
  const result = [...host.querySelectorAll("button")].find(
    (element) => element.textContent === label || element.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
};
async function click(label: string) {
  await act(async () => button(label).click());
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open(src = "https://remote.test/file.pdf", onRetry?: () => Promise<string | null>) {
  await act(async () => {
    root.render(<BrowserDocumentFrame src={src} title="Fixture" pdf onRetry={onRetry} />);
  });
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1),
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [{ target, contentRect: { width: 632, height: 432 } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(632);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(432);
  // jsdom has no layout: model centered scrolling using the fixture's text positions.
  HTMLElement.prototype.scrollIntoView = function () {
    const page = this.closest<HTMLElement>("[data-pdf-page]");
    const wrapper = page?.parentElement;
    const viewport = wrapper?.parentElement?.parentElement;
    if (!wrapper || !viewport) throw new Error("Missing PDF scroll viewport");
    const textTop = Number.parseFloat(this.parentElement!.style.top);
    viewport.scrollTop =
      Number.parseFloat(wrapper.style.top) + textTop + 8 - viewport.clientHeight / 2;
    viewport.dispatchEvent(new Event("scroll"));
  };
  load.mockReset().mockImplementation(async () => makeDocument());
  openLink.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  host.className = "flex";
  host.style.cssText = "width: 632px; height: 468px;";
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("integrated PDF surface", () => {
  it.each([false, true])(
    "leaves the selected occurrence centered below the fold (next match: %s)",
    async (next) => {
      load.mockImplementation(async () => makeDocument(["First needle", "Second needle"]));
      await open();
      const page = host.querySelector<HTMLElement>('[aria-label="Page 1"]')!;
      const viewport = page.parentElement!.parentElement!.parentElement!;
      expect(viewport.scrollTop).toBe(0);
      await click("Find");
      await type(
        host.querySelector<HTMLInputElement>('input[aria-label="Find in PDF"]')!,
        "needle",
      );
      if (next) await click("Next match");

      expect(host.querySelector('[aria-label="Page 1"]')).toBe(page);
      const selected = page.querySelector<HTMLElement>('mark[data-selected="true"]')!;
      expect(selected.parentElement?.textContent).toBe(next ? "Second needle" : "First needle");
      // Page top 16 + text top 560/720 + half the 16px mark - half the 432px viewport.
      expect(viewport.scrollTop).toBe(next ? 528 : 368);
    },
  );

  it("keeps focused PDF find out of the global chat capture handler", async () => {
    const threadFind = vi.fn();
    const capture = (event: KeyboardEvent) => {
      if (isPdfFindShortcut(event)) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "f") {
        threadFind();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", capture, true);
    try {
      await open();
      const viewer = host.querySelector<HTMLElement>("[data-pdf-viewer]")!;
      viewer.focus();
      await act(async () =>
        viewer.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "f",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(host.querySelector('[role="search"]')).not.toBeNull();
      expect(threadFind).not.toHaveBeenCalled();
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
      );
      expect(threadFind).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", capture, true);
    }
  });

  it("opens safe external links and follows internal links to offscreen pages", async () => {
    await open();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    const external = host.querySelector<HTMLAnchorElement>('a[href="https://example.com/"]')!;
    await act(async () => external.click());
    expect(openLink).toHaveBeenCalledWith("https://example.com/");
    const internal = host.querySelector<HTMLAnchorElement>('a[aria-label="Go to page 30"]')!;
    await act(async () => internal.click());
    expect(host.querySelector('[aria-label="Page 30"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="PDF page number"]')?.value).toBe(
      "30",
    );
  });
  it("uses focused document find to reach an unrendered page and frees the offscreen canvas", async () => {
    await open();
    expect(button("Find")).toBeDefined();
    const canvas = host.querySelector("canvas");
    expect(canvas?.width).toBeGreaterThan(0);
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    const viewer = host.querySelector('[role="region"]')!;
    await act(async () => {
      viewer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "f", ctrlKey: true, cancelable: true }),
      );
    });
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Find in PDF"]')!;
    expect(input).not.toBeNull();
    await type(input, "needle");
    expect(host.textContent).toContain("1 of 2 matches");
    await click("Next match");
    expect(host.textContent).toContain("2 of 2 matches");
    expect(host.querySelector('[aria-label="Page 30"]')).not.toBeNull();
    expect(canvas?.width).toBe(0);
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    expect(host.querySelector('mark[data-selected="true"]')?.textContent).toBe("needle");
    await click("Next match");
    expect(host.querySelector('[aria-label="Page 1"]')).not.toBeNull();
    await click("Close find");
    expect(host.querySelector('[role="search"]')).toBeNull();
  });
  it("reloads a failed PDF with a renewed signed URL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    const refresh = vi.fn(async () => "https://remote.test/fresh.pdf");
    await open("https://remote.test/expired.pdf", refresh);
    expect(host.textContent).toContain("Failed to load PDF (403)");
    await click("Try again");
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "https://remote.test/expired.pdf",
      "https://remote.test/fresh.pdf",
    ]);
    expect(host.querySelector("canvas")).not.toBeNull();
  });
  it("does not refetch stale bytes when refreshing authorization fails", async () => {
    await open("https://remote.test/file.pdf", async () => null);
    await click("Reload PDF");
    expect(host.textContent).toContain("Reconnect to the environment and try again.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("disposes each resource across A -> B -> A and starts each visit at page 1", async () => {
    await open("/a.pdf");
    const first = (await load.mock.results[0]!.value) as PDFDocumentProxy;
    await click("Next PDF page");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="PDF page number"]')?.value).toBe(
      "2",
    );
    await open("/b.pdf");
    expect(first.loadingTask.destroy).toHaveBeenCalledOnce();
    await open("/a.pdf");
    expect(load).toHaveBeenCalledTimes(3);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="PDF page number"]')?.value).toBe(
      "1",
    );
  });
  it("replaces cancelled zoom canvases and navigates pages from a submitted draft", async () => {
    await open();
    const canvas = host.querySelector("canvas");
    await click("Zoom in");
    expect(canvas?.width).toBe(0);
    expect(host.querySelector("canvas")).not.toBe(canvas);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="PDF page number"]')!;
    await type(input, "15");
    await act(async () =>
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.querySelector('[aria-label="Page 15"]')).not.toBeNull();
  });
  it("resets an invalid page draft to the current page", async () => {
    const navigate = vi.fn();
    await act(() => root.render(<PdfPageInput page={3} count={30} navigate={navigate} />));
    const input = host.querySelector("input")!;
    await type(input, "99");
    await act(() =>
      input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(input.value).toBe("3");
    expect(navigate).not.toHaveBeenCalled();
  });
});
