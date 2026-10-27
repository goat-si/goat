import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { goatThreadCallOf } from "./goatThreadCalls";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { findSendingCall, sendingCallRowIndex } from "./useSentCallReveal";

const at = DateTime.makeUnsafe("2026-10-27T00:00:00.000Z");

function callTimelineEntry(
  toolName: string,
  input: unknown,
  output: unknown,
  status: OrchestrationV2TurnItem["status"] = "completed",
  id = "tool",
) {
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread-sender"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName,
    input,
    output,
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
  if (entry?.kind !== "work") throw new Error("expected a work entry");
  return entry;
}

const callEntry = (...args: Parameters<typeof callTimelineEntry>) =>
  callTimelineEntry(...args).entry;

describe("goatThreadCallOf", () => {
  it("reads the thread and message a named thread.send delivered", () => {
    const call = goatThreadCallOf(
      callEntry(
        "goat.goat_thread_send",
        { threadId: "thread-lane", message: "Rebase onto dev" },
        { threadId: "thread-lane", messageId: "message-1", status: "starting" },
      ),
    );
    expect(call).toMatchObject({
      kind: "send",
      threadIds: ["thread-lane"],
      messageId: "message-1",
    });
  });

  it("reads a thread.launch made through goat_call with an MCP envelope result", () => {
    const call = goatThreadCallOf(
      callEntry(
        "mcp__goat__goat_call",
        { path: "thread.launch", args: { title: "Lane 1", prompt: "Fix it" } },
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "ok", value: { threadId: "thread-l1" } }),
            },
          ],
        },
      ),
    );
    expect(call).toMatchObject({ kind: "launch", threadIds: ["thread-l1"], title: "Lane 1" });
  });

  it("reads every thread create_threads made and the host of an SSH launch", () => {
    expect(
      goatThreadCallOf(
        callEntry(
          "goat_thread_create_many",
          { threads: [] },
          { threads: [{ threadId: "thread-a" }, { threadId: "thread-b" }] },
        ),
      )?.threadIds,
    ).toEqual(["thread-a", "thread-b"]);
    expect(
      goatThreadCallOf(
        callEntry(
          "goat_ssh_thread_launch",
          { host: "mini" },
          { host: "mini", threadId: "thread-r" },
        ),
      ),
    ).toMatchObject({ kind: "ssh_launch", host: "mini", threadIds: ["thread-r"] });
  });

  it("ignores other tools, calls still running and failed results", () => {
    expect(
      goatThreadCallOf(callEntry("goat_thread_read", { threadId: "t" }, { thread: {} })),
    ).toBeNull();
    expect(
      goatThreadCallOf(callEntry("goat_thread_send", { threadId: "t" }, undefined, "running")),
    ).toBeNull();
    expect(
      goatThreadCallOf(callEntry("goat_thread_send", { threadId: "t" }, { status: "error" })),
    ).toBeNull();
  });
});

describe("findSendingCall", () => {
  const launch = callTimelineEntry(
    "goat_thread_launch",
    { title: "Lane" },
    { threadId: "thread-lane" },
    "completed",
    "launch",
  );
  const firstSend = callTimelineEntry(
    "goat_thread_send",
    { threadId: "thread-lane" },
    { threadId: "thread-lane", messageId: "message-1" },
    "completed",
    "send-1",
  );
  const secondSend = callTimelineEntry(
    "goat_thread_send",
    { threadId: "thread-lane" },
    { threadId: "thread-lane", messageId: "message-2" },
    "completed",
    "send-2",
  );
  const entries = [launch, firstSend, secondSend];

  it("finds the send that delivered the message, not an earlier send to the same thread", () => {
    expect(findSendingCall(entries, { threadId: "thread-lane", messageId: "message-2" })?.id).toBe(
      secondSend.entry.id,
    );
  });

  it("falls back to the launch for the message that opened the launched thread", () => {
    expect(findSendingCall(entries, { threadId: "thread-lane", messageId: "message-0" })?.id).toBe(
      launch.entry.id,
    );
    expect(
      findSendingCall(entries, { threadId: "thread-other", messageId: "message-1" }),
    ).toBeNull();
  });

  it("points at the row showing the call", () => {
    const rows: MessagesTimelineRow[] = [
      {
        kind: "work",
        id: "row-0",
        createdAt: "",
        groupedEntries: [launch.entry],
        isExpandedToolGroup: false,
      },
      {
        kind: "work",
        id: "row-1",
        createdAt: "",
        groupedEntries: [firstSend.entry, secondSend.entry],
        isExpandedToolGroup: true,
      },
    ];
    expect(sendingCallRowIndex(rows, secondSend.entry)).toBe(1);
  });
});
