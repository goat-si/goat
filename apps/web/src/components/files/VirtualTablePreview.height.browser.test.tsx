import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import "~/index.css";
import VirtualTablePreview from "./VirtualTablePreview";

it("keeps row height and vertical position stable across horizontal scroll, fresh row arrays, resize, and typography changes", async () => {
  const columns = 35;
  const header = Array.from({ length: columns }, (_, i) => `Col ${i}`);
  const forcedEightLines = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\n");
  const wrappedTwelveWords = Array.from({ length: 12 }, (_, i) => `segment${i + 1}`).join(" ");
  const makeRows = () => [
    header,
    ...Array.from({ length: 24 }, (_, rowIndex) =>
      Array.from({ length: columns }, (_, columnIndex) => {
        if (rowIndex === 0) {
          if (columnIndex >= 10 && columnIndex < 28) return forcedEightLines;
          if (columnIndex === 34) return wrappedTwelveWords;
        }
        if (columnIndex === 33 && rowIndex % 3 === 1) return forcedEightLines;
        // Wide lowercase glyphs that wrap without spaces or newlines.
        if (rowIndex === 2 && columnIndex === 34) return "m".repeat(11);
        return `r${rowIndex + 1}-c${columnIndex}`;
      }),
    ),
  ];
  const view = (width: number) => (
    <div style={{ display: "flex", height: 320, width }}>
      <VirtualTablePreview
        name="wide-wrapped.csv"
        count={25}
        columns={columns}
        header={header}
        // Fresh arrays per call must not loop or lose measured row heights.
        getRows={(page) => (page === 0 ? makeRows() : undefined)}
      />
    </div>
  );
  const previousSettings = getClientSettings();
  const previousRootFontSize = document.documentElement.style.fontSize;
  try {
    await using screen = await render(view(420));
    const horizontal = () => screen.container.querySelector('[role="table"]')!.parentElement!;
    const vertical = () => screen.container.querySelector<HTMLElement>('[tabindex="0"]')!;
    const row = (index: number) =>
      screen.container.querySelector<HTMLElement>(`[data-preview-row="${index}"]`)!;

    await vi.waitFor(() => {
      expect(row(1)).not.toBeNull();
      expect(row(1).getBoundingClientRect().height).toBeGreaterThan(150);
    });

    const initialRow1Height = row(1).getBoundingClientRect().height;
    const initialRow2Height = row(2).getBoundingClientRect().height;
    const initialRow3Height = row(3).getBoundingClientRect().height;
    const initialRow4Top = row(4).getBoundingClientRect().top;

    // Scroll to the far right where the word-wrapped column 34 mounts after 18 newline cells.
    await act(() => {
      horizontal().scrollLeft = horizontal().scrollWidth;
      horizontal().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await vi.waitFor(() => expect(screen.container.textContent).toContain("segment12"));

    expect(Math.abs(row(1).getBoundingClientRect().height - initialRow1Height)).toBeLessThan(1);
    expect(Math.abs(row(2).getBoundingClientRect().height - initialRow2Height)).toBeLessThan(1);
    expect(row(3).getBoundingClientRect().height).toBeGreaterThan(40);
    expect(Math.abs(row(3).getBoundingClientRect().height - initialRow3Height)).toBeLessThan(1);
    expect(Math.abs(row(4).getBoundingClientRect().top - initialRow4Top)).toBeLessThan(1);

    // Scroll vertically into the table, then sweep horizontally back to the left edge.
    await act(() => {
      vertical().scrollTop = 120;
      vertical().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await vi.waitFor(() => expect(row(5)).not.toBeNull());
    const scrolledRow5Top = row(5).getBoundingClientRect().top;
    const scrolledRow5Height = row(5).getBoundingClientRect().height;

    await act(() => {
      horizontal().scrollLeft = 0;
      horizontal().dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await vi.waitFor(() => expect(screen.container.textContent).toContain("r6-c0"));

    expect(Math.abs(row(5).getBoundingClientRect().height - scrolledRow5Height)).toBeLessThan(1);
    expect(Math.abs(row(5).getBoundingClientRect().top - scrolledRow5Top)).toBeLessThan(1);

    // Widening the container widens each uniform column, reducing wrapped line count.
    await screen.rerender(view(1600));
    await vi.waitFor(() =>
      expect(row(1).getBoundingClientRect().height).toBeLessThan(initialRow1Height),
    );
    const widenedRow1Height = row(1).getBoundingClientRect().height;

    // Typography changes invalidate cached minimums even at the same container width.
    await act(() => {
      document.documentElement.style.fontSize = "20px";
      __setClientSettingsForTests({
        ...previousSettings,
        fontSizeInterface: previousSettings.fontSizeInterface + 4,
      });
    });
    await vi.waitFor(() =>
      expect(row(1).getBoundingClientRect().height).toBeGreaterThan(widenedRow1Height),
    );
  } finally {
    document.documentElement.style.fontSize = previousRootFontSize;
    __setClientSettingsForTests(previousSettings);
  }
});
