import "~/index.css";
import { GTProvider } from "gt-react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render, stubGlobal } from "../../../../test/render";
import chinese from "~/i18n/translations/zh.json";
import { BrowserDocumentFrame } from "../BrowserDocumentFrame";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("./pdfEngine", () => ({
  loadPdfDocument: load,
  loadPdfEngine: async () => ({
    TextLayer: class {
      textDivs: HTMLElement[] = [];
      textContentItemsStr: string[] = [];
      constructor(
        private options: {
          container: HTMLElement;
          textContentSource: { items: { str: string }[] };
        },
      ) {}
      async render() {
        this.textContentItemsStr = this.options.textContentSource.items.map((item) => item.str);
        this.textDivs = this.textContentItemsStr.map((str) => {
          const span = document.createElement("span");
          span.textContent = str;
          this.options.container.append(span);
          return span;
        });
      }
      cancel() {}
    },
  }),
}));

it("localizes PDF find controls and both versions of the result count", async () => {
  load.mockReset().mockResolvedValue({
    numPages: 2,
    loadingTask: { destroy: vi.fn(async () => {}) },
    getPage: async (pageNumber: number) => ({
      pageNumber,
      getViewport: () => ({
        width: 600,
        height: 800,
        convertToViewportPoint: (x: number, y: number) => [x, y],
      }),
      getAnnotations: async () => [],
      getTextContent: async () => ({ items: [{ str: `Page ${pageNumber} needle`, hasEOL: true }] }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      cleanup: vi.fn(),
    }),
  });
  using _fetch = stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new ArrayBuffer(1))),
  );
  const container = document.createElement("div");
  container.className = "flex";
  container.style.cssText = "width: 632px; height: 468px;";
  await using screen = await render(
    <GTProvider locale="zh" translations={{ zh: chinese }}>
      <BrowserDocumentFrame src="/fixture.pdf" title="Fixture" pdf />
    </GTProvider>,
    { container },
  );
  await userEvent.click(screen.getByRole("button", { name: "查找" }));
  const search = screen.getByRole("search", { name: "在 PDF 中查找" });
  await userEvent.type(screen.getByRole("textbox", { name: "在 PDF 中查找" }), "needle");
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[role="status"] [aria-hidden="true"]')?.textContent,
    ).toBe("1 / 2"),
  );
  expect(screen.container.querySelector('[role="status"] .sr-only')?.textContent).toBe(
    "第 1 项，共 2 项匹配",
  );
  await expect.element(screen.getByRole("button", { name: "上一个匹配项" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "下一个匹配项" }));
  await vi.waitFor(() =>
    expect(
      screen.container.querySelector('[role="status"] [aria-hidden="true"]')?.textContent,
    ).toBe("2 / 2"),
  );
  await userEvent.click(screen.getByRole("button", { name: "关闭查找" }));
  await expect.element(search).not.toBeInTheDocument();
});
