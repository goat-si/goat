import { MessageId, RunId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import type { ThreadFeedLatestRun } from "../../lib/threadActivity";
import type { ThreadFeedRow } from "./pending-thread-feed";
import { settledRunAnchorId, turnCanStop, workingFloatingStatus } from "./turn-settle";

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

it("Stop leaves with the Working pill once the provider turn ends, so a settling run cannot be cut short", () => {
  expect(turnCanStop("run-1", running)).toBe(true);
  expect(turnCanStop("run-1", { ...running, turnEnded: true })).toBe(false);
  expect(turnCanStop(null, running)).toBe(false);
  expect(turnCanStop("run-1", null)).toBe(true);
});

function message(id: string, role: "user" | "assistant", runId: RunId | null) {
  return {
    type: "message",
    id,
    createdAt: "2026-11-07T00:00:00.000Z",
    message: { id: MessageId.make(id), role, runId },
  } as unknown as ThreadFeedRow;
}

it("a settling run keeps its final reply in place; other updates anchor nothing", () => {
  const completed: ThreadFeedLatestRun = {
    ...running,
    status: "completed",
    completedAt: "2026-11-07T00:00:08.000Z",
  };
  const rows = [
    message("user-1", "user", running.runId),
    message("reply-early", "assistant", running.runId),
    message("reply-1", "assistant", running.runId),
    message("user-next", "user", null),
  ];
  expect(settledRunAnchorId(running, completed, rows)).toBe("reply-1");
  expect(settledRunAnchorId({ ...running, turnEnded: true }, completed, rows)).toBe("reply-1");
  expect(settledRunAnchorId(running, { ...running, turnEnded: true }, rows)).toBeNull();
  expect(settledRunAnchorId(completed, { ...completed }, rows)).toBeNull();
  expect(settledRunAnchorId(null, completed, rows)).toBeNull();
  expect(
    settledRunAnchorId({ ...running, runId: RunId.make("run-0") }, completed, rows),
  ).toBeNull();
});
