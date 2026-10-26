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
    error: null,
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
    error: null,
  });
  expect(scheduledTaskRunPresentation({ lastRunStatus: "running" }).label).toBe(
    "Outcome unavailable",
  );
});
it("drops an error that only repeats the outcome badge but keeps real and legacy errors", () => {
  const present = (lastRunError: string, lastRun?: ScheduledTaskRun) =>
    scheduledTaskRunPresentation({ lastRun, lastRunStatus: "failed", lastRunError }).error;
  expect(present("interrupted", run("interrupted"))).toBeNull();
  expect(present("The scheduled run could not be dispatched.", run("failed", "failed"))).toBe(
    "The scheduled run could not be dispatched.",
  );
  expect(present("interrupted")).toBe("interrupted");
});
