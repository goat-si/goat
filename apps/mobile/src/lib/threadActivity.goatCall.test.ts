import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { buildThreadFeed } from "./threadActivity";

const at = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");
const activitySummary = (toolName: string, input: unknown) => {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("tool"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input,
    output: { status: "ok", value: { items: [] } },
  };
  const [activity] = buildThreadFeed([
    {
      item,
      position: 0,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
    },
  ]).flatMap((entry) => (entry.type === "activity-group" ? entry.activities : []));
  return activity?.summary;
};

it("names a goat_call by the tool its path names", () => {
  // memory.search has no presentation of its own, so the row falls back to its tool name.
  expect(activitySummary("mcp__goat__goat_call", { path: "memory.search", args: {} })).toBe(
    "memory_search",
  );
  expect(
    activitySummary("mcp__goat__goat_call", { path: "thread.read", args: { threadId: "t2" } }),
  ).toBe(activitySummary("mcp__goat__goat_thread_read", { threadId: "t2" }));
});
