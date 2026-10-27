import { expect, it } from "@effect/vitest";
import type { ScreenRunResult } from "@goat/contracts";

import { cellResultSafety, screenActionSafety } from "./ScreenActionOutcome.ts";

const result = (receipts: ScreenRunResult["journal"][number]["receipt"][]): ScreenRunResult => ({
  runId: "r",
  turnId: "t",
  cellId: "c",
  status: "failed",
  error: { code: "not_run", effectStarted: false, nextStep: "Observe." },
  console: [],
  journal: receipts.map((receipt, index) => ({ sequence: index + 1, truncated: false, receipt })),
  truncated: [],
  availability: [],
  imageMetadata: [],
  images: [],
});
const receipt = (method: "click" | "observe", committed: boolean) => ({
  callId: 1,
  method,
  journalState: "settled" as const,
  category: committed ? ("confirmed" as const) : ("refused" as const),
  dispatched: committed,
  evidence: [],
  safety: screenActionSafety({ method }, committed ? "completed" : "refused", committed),
});

it("a cell whose earlier write committed may have committed as a whole, so it is never rerun", () => {
  expect(cellResultSafety(result([receipt("click", true)])).error).toMatchObject({
    safety: { possibleCommit: true, retryClass: "never" },
  });
  // Reads and refusals alone leave the cell's error as it was.
  expect(
    cellResultSafety(result([receipt("observe", true), receipt("click", false)])).error,
  ).not.toHaveProperty("safety");
});
