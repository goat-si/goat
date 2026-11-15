import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
} from "./session-logic";

describe("MCP apps in the timeline", () => {
  const runId = RunId.make("render-run");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-09-04T12:00:${String(second).padStart(2, "0")}.000Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("render-thread"),
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  });
  const renderCall = (
    status: OrchestrationV2TurnItem["status"],
    output?: unknown,
  ): OrchestrationV2TurnItem => ({
    ...base("render", 2),
    status,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: { title: "Chart", height: 420 },
    ...(output === undefined ? {} : { output }),
  });
  const command = (id: string, second: number): OrchestrationV2TurnItem => ({
    ...base(id, second),
    type: "command_execution",
    input: "vp test run",
  });
  const turn = (render: OrchestrationV2TurnItem) => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base("prompt", 0),
        type: "user_message",
        messageId: MessageId.make("prompt"),
        inputIntent: "turn_start",
        text: "Chart it",
        createdBy: "user",
        creationSource: "server",
        attachments: [],
      },
      command("before", 1),
      render,
      command("after", 3),
      {
        ...base("reply", 4),
        type: "assistant_message",
        messageId: MessageId.make("reply"),
        text: "Here it is.",
        streaming: false,
      },
    ];
    return deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map(visible),
      optimisticMessages: [],
    });
  };

  it("keeps an MCP app call's tool row and output beside its app card", () => {
    const mcpApp = {
      attachmentId: "render-thread-app-html",
      server: "repro",
      tool: "aggregate_rum_events",
      resourceUri: "ui://repro/dataviz",
    };
    const result = { content: [{ type: "text", text: "Notice\nview\tcount\n/home\t42" }] };
    const call = renderCall("completed", { goatMcpApp: mcpApp, result });
    const entries = turn(
      call.type === "dynamic_tool" ? { ...call, toolName: "repro.aggregate_rum_events" } : call,
    );
    expect(entries.find((entry) => entry.kind === "mcp-app")).toMatchObject({ mcpApp });
    const toolRows = entries.flatMap((entry) =>
      entry.kind === "work" && entry.entry.toolTitle === "repro.aggregate_rum_events"
        ? [entry.entry]
        : [],
    );
    expect(toolRows).toMatchObject([{ toolData: { output: { result } } }]);
  });

  it("drops an MCP app card when an update removes the call's app", () => {
    const mcpApp = {
      attachmentId: "render-thread-app-html",
      server: "repro",
      tool: "aggregate_rum_events",
      resourceUri: "ui://repro/dataviz",
    };
    const call = (output: unknown) => ({
      ...renderCall("completed", output),
      toolName: "repro.aggregate_rum_events",
    });
    const result = { content: [{ type: "text", text: "rows" }] };
    const input = (output: unknown) => ({
      visibleTurnItems: [visible(command("before", 1)), visible(call(output))],
      optimisticMessages: [],
    });
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      input({ goatMcpApp: mcpApp, result }),
    );
    const nextInput = input({ result });
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
  });
});
