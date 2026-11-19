import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

import { HtmlRenderDocument } from "./BrowserDocumentFrame";

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

describe("HtmlRenderDocument", () => {
  it("reports the page's first height and ignores messages from other windows", async () => {
    using pageUrl = (() => {
      const page = `<script>parent.postMessage(${JSON.stringify(sizeChanged(321))}, "*");</script>`;
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const onContentHeight = vi.fn();
    await using _screen = await render(
      <HtmlRenderDocument src={pageUrl.url} title="Report" onContentHeight={onContentHeight} />,
    );

    await vi.waitFor(() => expect(onContentHeight).toHaveBeenCalledWith(321));

    // Listeners run in registration order, so once this one sees the message the frame's has too.
    const delivered = new Promise<void>((resolve) =>
      window.addEventListener("message", () => resolve(), { once: true }),
    );
    window.postMessage(sizeChanged(999), "*");
    await delivered;
    expect(onContentHeight).toHaveBeenCalledTimes(1);
  });

  it("opens a clicked image with the other images of its block in the viewer", async () => {
    const swatch = (color: string) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><rect width="80" height="50" fill="${color}"/></svg>`,
      )}`;
    const html = injectHtmlRenderBootstrap(
      `<!doctype html><html><body><div>${["Red", "Green", "Blue"]
        .map((name) => `<img alt="${name}" src="${swatch(name.toLowerCase())}">`)
        .join("")}</div></body></html>`,
    );
    const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    await using screen = await render(<HtmlRenderDocument src={src} title="Swatches" />);

    await page.frameLocator(screen.getByTitle("Swatches")).getByAltText("Green").click();

    const viewer = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(viewer.getByAltText("Green")).toBeVisible();
    await expect.element(viewer.getByRole("button", { name: "Next media" })).toBeVisible();
    await expect.element(viewer.getByRole("button", { name: "Previous media" })).toBeVisible();
  });
});
import { injectHtmlRenderBootstrap } from "@goat/shared/htmlRender";

it("keeps the chat in place when a label far from its hidden radio is clicked", async () => {
  const html = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
    .r > input { position: absolute; opacity: 0; pointer-events: none; }
    .fill { height: 1400px; }
  </style></head><body><div class="r">
    <input type="radio" name="opt" id="opt-a" checked>
    <input type="radio" name="opt" id="opt-b">
    <label for="opt-a">Top A</label><label for="opt-b">Top B</label>
    <div class="fill"></div>
    <label for="opt-a">A</label><label for="opt-b">B</label>
  </div><script>
    document.getElementById("opt-b").addEventListener("change", function() {
      parent.postMessage({ type: "radio-changed", id: "opt-b" }, "*");
    });
  </script></body></html>`);
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const scroller = document.createElement("div");
  scroller.style.cssText = "height: 400px; overflow: auto; width: 728px;";
  const changed = vi.fn();
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  window.addEventListener(
    "message",
    (event) => {
      if (event.data?.type === "radio-changed") changed(event.data.id);
    },
    { signal: messages.signal },
  );
  const contentHeight = vi.fn((height: number) => {
    scroller.style.setProperty("--content-height", `${height}px`);
  });
  await using screen = await render(
    <>
      <style>{`iframe[title="Toggle"] {
        display: block; width: 100%; height: var(--content-height, 120px); border: 0;
      }`}</style>
      <div style={{ height: 600 }} />
      <HtmlRenderDocument src={src} title="Toggle" onContentHeight={contentHeight} />
      <div style={{ height: 100 }} />
    </>,
    { container: scroller },
  );

  const frame = screen.getByTitle("Toggle").element() as HTMLIFrameElement;
  await vi.waitFor(() => expect(frame.getBoundingClientRect().height).toBeGreaterThan(1400));
  scroller.scrollTop = scroller.scrollHeight;
  const scrollTop = scroller.scrollTop;

  await page.frameLocator(screen.getByTitle("Toggle")).getByText("B", { exact: true }).click();

  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("opt-b"));
  expect(scroller.scrollTop).toBe(scrollTop);
});
