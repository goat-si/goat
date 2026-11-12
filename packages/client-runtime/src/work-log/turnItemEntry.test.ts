import {
  OrchestrationV2TurnItemJson,
  type OrchestrationV2ProjectedTurnItem,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { summarizeToolGroup } from "./presentation.ts";
import { turnItemWorkLogEntry } from "./turnItemEntry.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const at = "2026-11-12T03:00:00.000Z";

const fixtures = {
  command: {
    type: "command_execution",
    input: "vp test run",
    commandActions: [],
    output: "ok",
    exitCode: 0,
  },
  readCommand: {
    type: "command_execution",
    input: "cat a.ts",
    commandActions: [{ type: "read", path: "a.ts" }],
    exitCode: 0,
  },
  fileChange: { type: "file_change", fileName: "src/a.ts" },
  fileSearch: { type: "file_search", pattern: "useEffect" },
  webSearch: { type: "web_search", patterns: ["goat bot"] },
  dynamicRead: { type: "dynamic_tool", toolName: "Read", input: { file_path: "/repo/a.ts" } },
  goatCall: {
    type: "dynamic_tool",
    toolName: "goat_call",
    input: { path: "memory.recall", args: { query: "deploy notes" } },
  },
  subagent: {
    type: "subagent",
    subagentId: "node-1",
    origin: "provider_native",
    driver: "codex",
    providerInstanceId: "codex",
    childThreadId: null,
    prompt: "Look around",
    result: null,
  },
  threadCreated: {
    type: "thread_created",
    targetThreadId: "t2",
    targetRunId: null,
    targetProviderInstanceId: "codex",
    targetModel: "gpt-5",
  },
} as const;

function row(name: keyof typeof fixtures): OrchestrationV2ProjectedTurnItem {
  const item = decode({
    id: name,
    threadId: "goat-bot-session:s1",
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    ...fixtures[name],
  });
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
}

describe("turnItemWorkLogEntry", () => {
  // Labels and summaries the web coding thread's projectedWorkEntry gave before it moved here.
  it.each([
    [
      "command",
      { label: "Ran command", toolTitle: "Command", command: "vp test run" },
      "Ran 1 command",
    ],
    ["readCommand", { label: "Ran command", command: "cat a.ts" }, "Read 1 file"],
    ["fileChange", { label: "Changed src/a.ts", changedFiles: ["src/a.ts"] }, "Changed 1 file"],
    ["fileSearch", { label: "Searched useEffect", detail: "useEffect" }, "Searched code 1 time"],
    ["webSearch", { label: "Searched the web", detail: "goat bot" }, "Searched the web 1 time"],
    ["dynamicRead", { label: "Read /repo/a.ts", toolTitle: "Read" }, "Read 1 file"],
    ["goatCall", { label: "memory_recall", toolTitle: "memory_recall" }, "Used 1 tool"],
    ["subagent", { label: "subagent" }, "Used 1 tool"],
    ["threadCreated", { label: "Created thread" }, "Created 1 thread"],
  ] as const)("keeps the coding thread's label for %s", (name, expected, summary) => {
    const entry = turnItemWorkLogEntry(row(name));
    expect(entry).toMatchObject({
      ...expected,
      id: name,
      createdAt: at,
      tone: "tool",
      toolLifecycleStatus: "completed",
      runId: "run-1",
    });
    expect(summarizeToolGroup([entry]).summary).toBe(summary);
  });
});
