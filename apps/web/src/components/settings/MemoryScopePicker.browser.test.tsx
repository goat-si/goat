import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { MemoryScopePicker } from "./MemoryScopePicker";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, 320, this.dataset.slot === "combobox-item" ? 32 : 224);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(224);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
  // LegendList measures layout sizes so popup transforms do not distort row heights.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.slot === "combobox-item" ? 32 : 224;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([200, 2000])(
  "virtualizes %i records and searches/selects the final destination",
  async (count) => {
    const select = vi.fn();
    await act(async () =>
      root.render(
        <MemoryScopePicker
          items={Array.from({ length: count }, (_, i) => ({
            id: `record-${i}`,
            title: `Destination ${i}`,
          }))}
          value={null}
          onChange={select}
          label="Memory thread"
          disabled={false}
        />,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    const rows = () => document.querySelectorAll('[data-slot="combobox-item"]');
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(40);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search memory thread"]',
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        `Destination ${count - 1}`,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().length).toBeLessThan(40);
    const last = [...rows()].find(
      (row) => row.textContent === `Destination ${count - 1}`,
    ) as HTMLElement;
    expect(last).toBeDefined();
    await act(async () => last.click());
    expect(select).toHaveBeenLastCalledWith(`record-${count - 1}`);
  },
);
