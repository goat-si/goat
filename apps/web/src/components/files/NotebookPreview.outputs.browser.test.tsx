import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "~/index.css";
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
import NotebookPreview from "./NotebookPreview";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

it("mounts a bounded set of saved notebook outputs as the reader scrolls", async () => {
  const notebook: Extract<OfficeWorkerResult, { type: "notebook" }> = {
    type: "notebook",
    language: "",
    cells: Array.from({ length: 20 }, (_, cell) => ({
      kind: "code",
      source: "",
      outputs: Array.from({ length: 100 }, (_, output) => ({
        kind: "html",
        text: `<p>saved ${cell}-${output}</p>`,
      })),
    })),
  };
  await using screen = await render(
    <div style={{ display: "flex", height: 400, width: 600 }}>
      <NotebookPreview notebook={notebook} />
    </div>,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelectorAll("iframe").length).toBeGreaterThan(0),
  );
  expect(screen.container.querySelectorAll("iframe").length).toBeLessThanOrEqual(16);
  const first = screen.container.querySelector("iframe")!;
  const firstOutput = first.parentElement!;
  expect(first.srcdoc).toContain("saved 0-0");
  await vi.waitFor(() => expect(first.clientHeight).toBeGreaterThan(0));
  const viewport = screen.container.querySelector<HTMLElement>(".scrollbar-gutter-both")!;
  await act(() => {
    viewport.scrollTop = viewport.scrollHeight;
  });
  await vi.waitFor(() => {
    expect(
      [...screen.container.querySelectorAll("iframe")].some((frame) =>
        frame.srcdoc.includes("saved 19-99"),
      ),
    ).toBe(true);
    expect(first.isConnected).toBe(false);
  });
  expect(screen.container.querySelectorAll("iframe").length).toBeLessThanOrEqual(16);
  const reservedHeight = firstOutput.getBoundingClientRect().height;
  using cleanup = new DisposableStack();
  const pending = new AbortController();
  cleanup.defer(() => pending.abort());
  // Hold the remounted frame in its loading state until it scrolls away again.
  firstOutput.addEventListener("load", (event) => event.stopPropagation(), {
    capture: true,
    signal: pending.signal,
  });
  await act(() => {
    viewport.scrollTop = 0;
  });
  await vi.waitFor(() => {
    expect(firstOutput.querySelector("iframe")?.srcdoc).toContain("saved 0-0");
    expect(firstOutput.getBoundingClientRect().height).toBe(reservedHeight);
  });
  await act(() => {
    viewport.scrollTop = viewport.scrollHeight;
  });
  await vi.waitFor(() => expect(firstOutput.querySelector("iframe")).toBeNull());
  expect(firstOutput.getBoundingClientRect().height).toBe(reservedHeight);
});
