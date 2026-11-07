import { MessageId, RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ThreadFeedLatestRun } from "../../lib/threadActivity";
import type { ThreadFeedRow } from "./pending-thread-feed";
import { settledRunAnchorId, workingFloatingStatus } from "./turn-settle";

const runId = RunId.make("run-1");
const running: ThreadFeedLatestRun = {
  runId,
  status: "running",
  startedAt: "2026-11-07T00:00:00.000Z",
  completedAt: null,
};
const turnEnded: ThreadFeedLatestRun = { ...running, turnEnded: true };
const completed: ThreadFeedLatestRun = {
  ...running,
  status: "completed",
  completedAt: "2026-11-07T00:00:08.000Z",
};

function message(id: string, role: "user" | "assistant", run: RunId | null) {
  return {
    type: "message",
    id,
    createdAt: "2026-11-07T00:00:00.000Z",
    message: { id: MessageId.make(id), role, runId: run },
  } as unknown as ThreadFeedRow;
}

describe("Working pill", () => {
  it("leaves once the provider turn ends, as the feed's live row does, while the server settles the run", () => {
    const startedAt = "2026-11-07T00:00:00.000Z";
    expect(workingFloatingStatus(startedAt, running)).toEqual({ kind: "working", startedAt });
    expect(workingFloatingStatus(startedAt, turnEnded)).toBeNull();
    expect(workingFloatingStatus(startedAt, null)).toEqual({ kind: "working", startedAt });
    expect(workingFloatingStatus(null, running)).toBeNull();
  });
});

describe("settled run scroll anchor", () => {
  const rows = [
    message("user-1", "user", runId),
    message("reply-early", "assistant", runId),
    message("reply-1", "assistant", runId),
    message("user-next", "user", null),
  ];

  it("keeps the run's final reply in place when its work folds", () => {
    expect(settledRunAnchorId(running, completed, rows)).toBe("reply-1");
    expect(settledRunAnchorId(turnEnded, completed, rows)).toBe("reply-1");
  });

  it("anchors nothing for updates that do not settle a run", () => {
    expect(settledRunAnchorId(running, turnEnded, rows)).toBeNull();
    expect(settledRunAnchorId(completed, { ...completed }, rows)).toBeNull();
    expect(settledRunAnchorId(null, completed, rows)).toBeNull();
    expect(
      settledRunAnchorId({ ...running, runId: RunId.make("run-0") }, completed, rows),
    ).toBeNull();
  });
});
