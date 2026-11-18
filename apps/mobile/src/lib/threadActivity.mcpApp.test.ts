import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import { buildThreadFeed } from "./threadActivity";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

it("keeps an MCP app call's tool activity beside its app card", () => {
  const mcpApp = {
    attachmentId: "repro-app-html",
    server: "repro",
    tool: "aggregate_rum_events",
    resourceUri: "ui://repro/dataviz",
  };
  const item: OrchestrationV2TurnItem = {
    ...base("repro-app", "2026-08-29T00:00:00.000Z", 1),
    type: "dynamic_tool",
    toolName: "repro.aggregate_rum_events",
    input: { query: "@type:view" },
    output: {
      goatMcpApp: mcpApp,
      result: { content: [{ type: "text", text: "Notice\nview\tcount\n/home\t42" }] },
    },
  };
  const feed = buildThreadFeed([projected(item, 0)]);
  expect(feed).toContainEqual(expect.objectContaining({ type: "mcp-app", app: mcpApp }));
  const activities = feed.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  );
  expect(activities).toHaveLength(1);
  expect(activities[0]?.getFullDetail()).toContain("@type:view");
});
