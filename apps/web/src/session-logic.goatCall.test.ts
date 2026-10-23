import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "./session-logic";

const at = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");
const workEntry = (toolName: string, input: unknown) => {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("tool"),
    threadId: ThreadId.make("thread-1"),
    runId: null,
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
  const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        item,
        position: 0,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      },
    ],
    optimisticMessages: [],
  });
  return entry?.kind === "work" ? entry.entry : null;
};

it("names a goat_call to a tool without its own presentation by that tool", () => {
  const entry = workEntry("mcp__goat__goat_call", { path: "memory.search", args: { query: "x" } });
  expect(entry).toMatchObject({ label: "memory_search", toolTitle: "memory_search" });
  // The details keep the call as the agent made it.
  expect(entry?.toolData).toMatchObject({ input: { path: "memory.search" } });
});
