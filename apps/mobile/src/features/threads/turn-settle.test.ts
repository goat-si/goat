import { RunId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import type { ThreadFeedLatestRun } from "../../lib/threadActivity";
import { workingFloatingStatus } from "./turn-settle";

const running: ThreadFeedLatestRun = {
  runId: RunId.make("run-1"),
  status: "running",
  startedAt: "2026-11-07T00:00:00.000Z",
  completedAt: null,
};

it("the Working pill leaves once the provider turn ends, as the feed's live row does, while the server settles the run", () => {
  const startedAt = "2026-11-07T00:00:00.000Z";
  expect(workingFloatingStatus(startedAt, running)).toEqual({ kind: "working", startedAt });
  expect(workingFloatingStatus(startedAt, { ...running, turnEnded: true })).toBeNull();
  expect(workingFloatingStatus(startedAt, null)).toEqual({ kind: "working", startedAt });
  expect(workingFloatingStatus(null, running)).toBeNull();
});
