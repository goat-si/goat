import { expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

it("shows the restart notice once a working run's turn turns out to survive a restart", () => {
  // A continuation keeps its source run's work start, so the working row's id and time hold.
  const row: Extract<MessagesTimelineRow, { kind: "working" }> = {
    kind: "working",
    id: "working-indicator-row",
    survivingRestartNotice: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
  const notice =
    "Running since before the server restarted. Progress shows when this turn finishes.";
  const previous = computeStableMessagesTimelineRows([row], { result: [], byId: new Map() });
  const next = computeStableMessagesTimelineRows(
    [{ ...row, survivingRestartNotice: notice }],
    previous,
  );
  expect(next.result[0]).toMatchObject({ survivingRestartNotice: notice });
  expect(
    computeStableMessagesTimelineRows([{ ...row, survivingRestartNotice: null }], next).result[0],
  ).toMatchObject({ survivingRestartNotice: null });
  expect(
    computeStableMessagesTimelineRows([{ ...row, survivingRestartNotice: notice }], next),
  ).toBe(next);
});
