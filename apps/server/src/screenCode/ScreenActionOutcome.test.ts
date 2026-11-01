import { expect, it } from "@effect/vitest";
import type { ScreenRunResult } from "@goat/contracts";

import {
  cellResultSafety,
  cellTerminalError,
  screenActionSafety,
  finalScreenReply,
} from "./ScreenActionOutcome.ts";

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

it("a terminal result after successful input keeps the input and forbids retry", () => {
  const error = cellTerminalError(
    { code: "stopped", effectStarted: false, nextStep: "stopped" },
    [receipt("click", true)],
    "stopped_by_person",
  );
  expect(error).toMatchObject({
    code: "stopped_by_person",
    effectStarted: true,
    safety: { possibleCommit: true, retryClass: "never" },
  });
});
const receipt = (method: "click" | "observe" | "tab_status" | "read_page", committed: boolean) => ({
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
  // Read-only cells explicitly report that no write can have committed.
  expect(
    cellResultSafety(result([receipt("tab_status", true), receipt("read_page", true)])).error,
  ).toMatchObject({ safety: { possibleCommit: false, code: "read_indeterminate" } });
});

it("the final screen reply merges a late cutoff and preserves possible input", () => {
  const call = {
    t: "call",
    runId: "r",
    turnId: "t",
    cellId: "c",
    callId: 1,
    method: "click",
    args: {},
    deadlineMillis: 1000,
  } satisfies import("@goat/contracts").ScreenHostCall;
  const reply = {
    t: "reply",
    runId: "r",
    cellId: "c",
    callId: 1,
    outcome: "ok",
  } satisfies import("@goat/contracts").ScreenHostReply;
  const final = finalScreenReply(reply, call, "stopped_by_person", [
    { sequence: 1, truncated: false, receipt: receipt("click", true) },
  ]);
  expect(final).toMatchObject({
    outcome: "error",
    error: { code: "stopped_by_person", safety: { retryClass: "never", possibleCommit: true } },
  });
});
