import { describe, expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { attachTimelineViewport } from "./timelineViewport";

describe("attachTimelineViewport", () => {
  // The scroller needs no routes.
  it("reports a scrollbar press but not a click on the scroller's empty padding", async () => {
    await using screen = await render(
      <div
        data-testid="timeline"
        style={{ height: 300, width: 400, overflowY: "auto", padding: "0 42px" }}
      >
        <div style={{ height: 1200 }} />
      </div>,
      { router: false },
    );
    const timeline = screen.getByTestId("timeline").element() as HTMLElement;
    const viewport = attachTimelineViewport(timeline);
    const navigations: unknown[] = [];
    viewport.subscribe((navigation) => navigations.push(navigation));

    await userEvent.click(screen.getByTestId("timeline"), { position: { x: 10, y: 150 } });
    await userEvent.click(screen.getByTestId("timeline"), {
      position: { x: timeline.offsetWidth - 2, y: 150 },
    });

    expect(navigations).toEqual([
      { source: "pointer", onScrollbar: false },
      { source: "pointer", onScrollbar: true },
    ]);
    viewport.dispose();
  });
});
