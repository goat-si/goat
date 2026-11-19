import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../../test/render";
import type { PDFDocumentProxy } from "./pdfEngine";

vi.mock("./pdfEngine", () => ({
  loadPdfEngine: async () => ({
    TextLayer: class {
      textDivs = [];
      textContentItemsStr = [];
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
  }),
}));
vi.mock(import("./pdfLinks"), () => ({ extractPageLinks: async () => [] }));
import { PdfPage } from "./PdfPage";

it("keeps the painted page visible until its resized replacement is ready", async () => {
  let finish = () => {};
  let renders = 0;
  const document = {
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale }),
      render: () => ({
        promise:
          ++renders === 1
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                finish = resolve;
              }),
        cancel() {},
      }),
      getTextContent: async () => ({ items: [] }),
      cleanup() {},
    }),
  } as unknown as PDFDocumentProxy;
  const page = (scale: number) => (
    <PdfPage
      document={document}
      number={1}
      scale={scale}
      width={100 * scale}
      height={100 * scale}
      matches={[]}
      selected={undefined}
      navigate={() => {}}
      openLink={async () => {}}
      needsEnvironmentRoute={() => false}
    />
  );
  await using screen = await render(page(1), { router: false /* no links */ });
  await vi.waitFor(() =>
    expect(screen.container.querySelector("canvas")?.width).toBeGreaterThan(0),
  );
  const original = screen.container.querySelector("canvas");
  await screen.rerender(page(2));
  await vi.waitFor(() => expect(renders).toBe(2));
  expect(original?.isConnected).toBe(true);
  expect(original?.width).toBeGreaterThan(0);
  finish();
  await vi.waitFor(() => expect(original?.isConnected).toBe(false));
});
