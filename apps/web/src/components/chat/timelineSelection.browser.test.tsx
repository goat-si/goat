import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { selectedTimelineRowIds, timelineRowSpanIndices } from "./timelineSelection";

it("pins every row between the ends of a native timeline selection", async () => {
  // The selection has no routes.
  await using screen = await render(
    <div data-testid="viewport">
      <div data-timeline-row-id="a">first</div>
      <div data-timeline-row-id="c">last</div>
    </div>,
    { router: false },
  );
  const viewport = screen.getByTestId("viewport").element();
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.setStart(viewport.children[0]!.firstChild!, 1);
  range.setEnd(viewport.children[1]!.firstChild!, 2);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(
    timelineRowSpanIndices(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      selectedTimelineRowIds(viewport),
    ),
  ).toEqual([0, 1, 2]);
  selection.removeAllRanges();
  expect(selectedTimelineRowIds(viewport)).toEqual([]);
});
