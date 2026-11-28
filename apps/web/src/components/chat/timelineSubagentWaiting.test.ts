import {
  ThreadId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  TurnItemId,
  MessageId,
  RunId,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

describe("parent run waiting on foreground subagents", () => {
  const runId = RunId.make("parent-run");
  const threadId = ThreadId.make("parent-thread");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-10-06T10:00:${String(second).padStart(2, "0")}Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: ProviderTurnId.make("parent-provider-turn"),
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const child = (id: string, second: number): OrchestrationV2TurnItem => ({
    ...base(id, second),
    status: "running",
    completedAt: null,
    type: "subagent",
    subagentId: NodeId.make(id),
    origin: "provider_native",
    driver: ProviderDriverKind.make("opencode"),
    providerInstanceId: ProviderInstanceId.make("opencode"),
    childThreadId: null,
    prompt: `Read ${id}`,
    result: null,
  });

  const liveRow = (later: ReadonlyArray<OrchestrationV2TurnItem>, toolCallVisibility?: "hideAll") =>
    deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: (
          [
            {
              ...base("user", 0),
              status: "completed",
              type: "user_message",
              messageId: MessageId.make("user"),
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              text: "Research these in parallel",
              attachments: [],
            },
            {
              ...base("assistant", 1),
              status: "completed",
              type: "assistant_message",
              messageId: MessageId.make("assistant"),
              text: "Dispatching three subagents.",
              streaming: false,
            },
            child("a", 2),
            { ...child("b", 3), status: "completed", completedAt: at(3) },
            child("c", 4),
            ...later,
          ] satisfies OrchestrationV2TurnItem[]
        ).map((item) => ({
          position: item.ordinal,
          visibility: "local" as const,
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
        optimisticMessages: [],
      }),
      latestRun: {
        runId,
        status: "running",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: DateTime.formatIso(at(0)),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      ...(toolCallVisibility ? { toolCallVisibility } : {}),
    }).find((row) => row.id === "live-activity-row");
  const thinking = {
    kind: "thinking",
    id: "live-activity-row",
    createdAt: DateTime.formatIso(at(0)),
  };

  it("names the running children while the open run has done nothing since launching them", () => {
    expect(liveRow([])).toEqual({ ...thinking, label: "Waiting on 2 subagents" });
    expect(liveRow([], "hideAll")).toEqual({ ...thinking, label: "Waiting on 2 subagents" });
  });

  // regression: #40551 a finished status after the children is the parent parking, not new work
  it("names the running children when the parent's finished status message follows them", () => {
    const status: OrchestrationV2TurnItem = {
      ...base("status", 5),
      status: "completed",
      type: "assistant_message",
      messageId: MessageId.make("status"),
      text: "Subagents launched; waiting for them to report back.",
      streaming: false,
    };
    expect(liveRow([status])).toEqual({ ...thinking, label: "Waiting on 2 subagents" });
    expect(liveRow([{ ...status, runId: RunId.make("other-run") }])).toEqual(thinking);
  });

  it("keeps Thinking when a hidden newer parent command follows the children", () => {
    const command: OrchestrationV2TurnItem = {
      ...base("command", 5),
      status: "running",
      completedAt: null,
      type: "command_execution",
      input: "sleep 5",
    };
    expect(liveRow([command], "hideAll")).toEqual(thinking);
  });
});
