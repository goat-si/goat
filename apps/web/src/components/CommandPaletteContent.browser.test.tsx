import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent
            items={["Project A"]}
            inputProps={{
              placeholder: "Search projects",
              startAddon: (
                <button type="button" aria-label="Back">
                  Back
                </button>
              ),
            }}
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

describe("CommandPaletteContent", () => {
  it("focuses the search input, not the Back button, when it opens into a submenu", async () => {
    await using _screen = await render(<SubmenuPalette />);

    await userEvent.click(page.getByRole("button", { name: "Open" }));

    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });
});

it.each([
  { entry: "@legendapp/list/react", height: 80, scale: 0.8 },
  { entry: "@legendapp/list/react-native", height: 80, scale: 0.8 },
  { entry: "@legendapp/list/react-native", height: 40.625, scale: 1 },
])(
  "reports only the $height px layout height when $entry mounts at scale $scale",
  async ({ entry, height, scale }) => {
    const { LegendList: List } =
      await vi.importActual<typeof import("@legendapp/list/react")>(entry);
    const onItemSizeChanged = vi.fn<(measurement: { size: number }) => void>();
    await using screen = await render(
      <div style={{ scale: String(scale) }}>
        <List
          data={["Project A"]}
          estimatedItemSize={100}
          keyExtractor={(item) => item}
          onItemSizeChanged={onItemSizeChanged}
          recycleItems={false}
          renderItem={({ item }) => <div style={{ height }}>{item}</div>}
          style={{ height: 100, width: 300 }}
        />
      </div>,
    );
    const row = screen.getByText("Project A");
    await expect.element(row).toBeVisible();
    expect(row.element().getBoundingClientRect().height).toBeCloseTo(height * scale);
    await vi.waitFor(() =>
      expect(onItemSizeChanged.mock.calls.map(([{ size }]) => size)).toEqual([height]),
    );
  },
);

it.each(["@legendapp/list/react", "@legendapp/list/react-native"])(
  "keeps the %s row's fractional layout height after a deferred shrink under scale",
  async (entry) => {
    // Both browser bundles expose the web implementation; native types add global declarations.
    const { LegendList: List } =
      await vi.importActual<typeof import("@legendapp/list/react")>(entry);
    const onItemSizeChanged = vi.fn<(measurement: { itemKey: string; size: number }) => void>();
    const onScroll = vi.fn();
    const projectSizes = () =>
      onItemSizeChanged.mock.calls.flatMap(([{ itemKey, size }]) =>
        itemKey === "Project A" ? [size] : [],
      );
    await using screen = await render(
      <div data-testid="scaled-list" style={{ scale: "0.8" }}>
        <List
          data={["Project A", "Project B"]}
          estimatedItemSize={100}
          keyExtractor={(item) => item}
          maintainVisibleContentPosition={false}
          onItemSizeChanged={onItemSizeChanged}
          onScroll={onScroll}
          recycleItems={false}
          renderItem={({ item }) => <div style={{ height: 80 }}>{item}</div>}
          style={{ height: 100, width: 300 }}
        />
      </div>,
    );
    await vi.waitFor(() => expect(projectSizes().at(-1)).toBe(80));
    const scroller = screen.getByTestId("scaled-list").element().firstElementChild;
    if (!(scroller instanceof HTMLElement)) throw new Error("Expected the list scroller");
    // The first scroll settles initial data layout so subsequent shrinks are deferred.
    scroller.scrollTop = 5;
    await vi.waitFor(() => expect(onScroll).toHaveBeenCalled());
    const row = screen.getByText("Project A").element();
    if (!(row instanceof HTMLElement)) throw new Error("Expected a project row");
    expect(row.getBoundingClientRect().height).toBe(64);
    onItemSizeChanged.mockClear();
    row.style.height = "40.625px";
    const nextRow = screen.getByText("Project B").element();
    await vi.waitFor(() => {
      expect(projectSizes()).toEqual([40.625]);
      const offset = nextRow.getBoundingClientRect().top - row.getBoundingClientRect().top;
      // Web row positions use whole layout pixels.
      expect(offset / 0.8).toBeCloseTo(41);
    });
  },
);
