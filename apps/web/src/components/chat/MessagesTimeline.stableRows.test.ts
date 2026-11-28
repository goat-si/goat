import { ThreadId, type WorktreeSetupSnapshot } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  computeStableMessagesTimelineRows,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

it("updates cached rows whose spacing or setup handoff changed without new content", () => {
  const working: MessagesTimelineRow = {
    kind: "working",
    id: "working",
    createdAt: "2026-01-01T00:00:00Z",
    continuesWorkLog: true,
  };
  const snapshot: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("thread-setup"),
    phase: "failed",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:01:00Z",
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
    sequence: 3,
  };
  const setup: MessagesTimelineRow = {
    kind: "worktree-setup",
    id: "setup",
    createdAt: snapshot.startedAt,
    snapshot,
    embedded: false,
  };
  const cached = computeStableMessagesTimelineRows([setup, working], {
    result: [],
    byId: new Map(),
  });
  const { continuesWorkLog: _continued, ...settledWorking } = working;
  const next = computeStableMessagesTimelineRows(
    [{ ...setup, embedded: true }, settledWorking],
    cached,
  );
  expect(next.result).toEqual([{ ...setup, embedded: true }, settledWorking]);
});
