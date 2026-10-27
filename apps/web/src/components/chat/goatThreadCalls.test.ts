import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { goatThreadCallOf } from "./goatThreadCalls";
import { callEntry, callTimelineEntry } from "./goatThreadCalls.fixtures";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { findSendingCall, sendingCallRowIndex } from "./useSentCallReveal";

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

  it("reads the GOAT tool names every provider spells", () => {
    for (const toolName of [
      "goat:goat_thread_send",
      "mcp_goat_goat_thread_send",
      "mcp__goat__goat_thread_send",
      "goat-thread1_goat_thread_send",
    ]) {
      expect(
        goatThreadCallOf(callEntry(toolName, {}, { threadId: "thread-lane", messageId: "m" }))
          ?.kind,
      ).toBe("send");
    }
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

  it("matches the launch only for the opening prompt, whose id is the thread's", () => {
    expect(
      findSendingCall(entries, { threadId: "thread-lane", messageId: "thread-lane" })?.id,
    ).toBe(launch.entry.id);
    // A later message whose send is still running or unreadable is not the launch.
    expect(
      findSendingCall(entries, { threadId: "thread-lane", messageId: "message-9" }),
    ).toBeNull();
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
    expect(sendingCallRowIndex(rows, secondSend.entry, () => undefined)).toBe(1);
  });

  it("points a call folded after a steer at its own segment, not the turn's first fold", () => {
    const runId = RunId.make("run-1");
    const rows: MessagesTimelineRow[] = [
      { kind: "turn-fold", id: "fold-turn", createdAt: "", runId, label: "", expanded: false },
      {
        kind: "turn-fold",
        id: "fold-steer",
        createdAt: "",
        runId: RunId.make("run-1:steer:s1"),
        label: "",
        expanded: false,
      },
    ];
    const folded = { ...secondSend.entry, runId };
    expect(sendingCallRowIndex(rows, folded, () => "run-1:steer:s1")).toBe(1);
  });
});
