import { expect, it } from "vite-plus/test";
import { CommandId, type ScheduledTaskRun } from "@goat/contracts";
import { scheduledTaskRunPresentation } from "./scheduledTaskRun.ts";
const run = (
  status: ScheduledTaskRun["status"],
  dispatchStatus: ScheduledTaskRun["dispatchStatus"] = "accepted",
): ScheduledTaskRun => ({
  firingId: CommandId.make("firing"),
  dispatchStatus,
  status,
  threadId: null,
  runId: null,
  requestedAt: "2026-10-15T00:00:00.000Z",
  dispatchedAt: null,
  startedAt: null,
  completedAt: null,
});
it.each([
  ["dispatching", "Dispatching", "info"],
  ["queued", "Queued", "info"],
  ["running", "Running", "info"],
  ["completed", "Completed", "success"],
  ["failed", "Failed", "error"],
  ["interrupted", "Interrupted", "warning"],
  ["cancelled", "Cancelled", "outline"],
  ["rolled_back", "Rolled back", "warning"],
  ["unknown", "Outcome unavailable", "outline"],
] as const)("presents %s as %s with tone %s", (status, label, tone) => {
  expect(scheduledTaskRunPresentation({ lastRun: run(status), lastRunStatus: "running" })).toEqual({
    label,
    tone,
  });
});
it("distinguishes dispatch rejection from a provider failure and makes legacy success explicit", () => {
  expect(
    scheduledTaskRunPresentation({ lastRun: run("failed", "failed"), lastRunStatus: "failed" })
      .label,
  ).toBe("Dispatch failed");
  expect(scheduledTaskRunPresentation({ lastRunStatus: "succeeded" })).toEqual({
    label: "Dispatched (legacy)",
    tone: "outline",
  });
  expect(scheduledTaskRunPresentation({ lastRunStatus: "running" }).label).toBe(
    "Outcome unavailable",
  );
});
