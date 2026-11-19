import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

import { BrowserDocumentFrame, HtmlRenderDocument } from "./BrowserDocumentFrame";

// These cases are the open viewer's; a closed one recognizes no Pen route URL.
vi.mock("@goat/shared/penViewerGate", () => ({ PEN_VIEWER_ENABLED: true }));

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

describe("HtmlRenderDocument", () => {
  it("runs no page from a Pen route, whose URL carries the route's capability", async () => {
    const src = `http://127.0.0.1:1234/pen-route/${"a".repeat(43)}/api/assets/page.html`;
    for (const htmlRender of [true, false]) {
      await using screen = await render(
        <BrowserDocumentFrame src={src} title="Page" pdf={false} htmlRender={htmlRender} />,
      );
      await expect
        .element(screen.getByText("Pages from a machine reached through Pen can't run here yet."))
        .toBeVisible();
      expect(document.querySelector("iframe")).toBeNull();
    }
    // Chat renders an agent's HTML through HtmlRenderDocument itself, inline and full screen.
    await using screen = await render(<HtmlRenderDocument src={src} title="Report" />);
    await expect
      .element(screen.getByText("Pages from a machine reached through Pen can't run here yet."))
      .toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
  });

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
