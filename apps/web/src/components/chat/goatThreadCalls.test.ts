import { NodeId, RunAttemptId, RunId } from "@goat/contracts";
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
    expect(findSendingCall(entries, { threadId: "thread-lane", messageId: "message-2" })).toBe(
      secondSend,
    );
  });

  it("matches the launch only for the opening prompt, whose id is the thread's", () => {
    expect(findSendingCall(entries, { threadId: "thread-lane", messageId: "thread-lane" })).toBe(
      launch,
    );
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
    expect(sendingCallRowIndex(rows, [], secondSend, () => undefined)).toBe(1);
  });

  it("points a call in a superseded attempt at that attempt's own fold", () => {
    const runId = RunId.make("run-1");
    const attemptFold = (id: string) => ({
      kind: "attempt-fold" as const,
      id: "fold-" + id,
      createdAt: "",
      runId,
      attemptId: RunAttemptId.make(id),
      label: "Superseded attempt",
      expanded: false,
    });
    const rows: MessagesTimelineRow[] = [attemptFold("attempt-1"), attemptFold("attempt-2")];
    const inSecond = {
      ...secondSend,
      attempt: {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: NodeId.make("node-2"),
        status: "interrupted",
        completedAt: null,
      },
    } satisfies typeof secondSend;
    expect(sendingCallRowIndex(rows, [], inSecond, () => undefined)).toBe(1);
  });

  it("skips an open turn and finds the closed attempt fold inside it", () => {
    const runId = RunId.make("run-1");
    const attemptFold = (id: string) => ({
      kind: "attempt-fold" as const,
      id: "fold-" + id,
      createdAt: "",
      runId,
      attemptId: RunAttemptId.make(id),
      label: "Superseded attempt",
      expanded: false,
    });
    const rows: MessagesTimelineRow[] = [
      { kind: "turn-fold", id: "turn", createdAt: "", runId, label: "", expanded: true },
      attemptFold("attempt-1"),
      attemptFold("attempt-2"),
    ];
    const inSecond = {
      ...secondSend,
      attempt: {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: NodeId.make("node-2"),
        status: "interrupted",
        completedAt: null,
      },
    } satisfies typeof secondSend;
    expect(sendingCallRowIndex(rows, [], inSecond, () => "run-1")).toBe(2);
  });

  it("goes past an open turn and an open attempt to the closed tool group holding the call", () => {
    const runId = RunId.make("run-1");
    const rows: MessagesTimelineRow[] = [
      { kind: "turn-fold", id: "turn", createdAt: "", runId, label: "", expanded: true },
      {
        kind: "attempt-fold",
        id: "attempt",
        createdAt: "",
        runId,
        attemptId: RunAttemptId.make("attempt-1"),
        label: "Superseded attempt",
        expanded: true,
      },
      {
        kind: "work-toggle",
        id: "work-toggle:send-2",
        createdAt: "2026-10-27T00:00:00.000Z",
        runId,
        groupId: "group",
        hiddenCount: 2,
        expanded: false,
        summary: "",
        summaryKind: "dynamic-tool",
        hasFailure: false,
      },
    ];
    const call = {
      ...secondSend,
      entry: { ...secondSend.entry, runId },
      attempt: {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: NodeId.make("node-1"),
        status: "interrupted",
        completedAt: null,
      },
    } satisfies typeof secondSend;
    expect(sendingCallRowIndex(rows, [call], call, () => "run-1")).toBe(2);
  });

  it("picks the collapsed tool group holding the call, not a later one with the same timestamp", () => {
    const runId = RunId.make("run-1");
    const toggle = (startId: string) => ({
      kind: "work-toggle" as const,
      id: "work-toggle:" + startId,
      createdAt: "2026-10-27T00:00:00.000Z",
      runId,
      groupId: "work-group:" + startId,
      hiddenCount: 2,
      expanded: false,
      summary: "",
      summaryKind: "dynamic-tool" as const,
      hasFailure: false,
    });
    const later = callTimelineEntry("goat_thread_read", {}, {}, "completed", "read-1");
    const between = callTimelineEntry("goat_thread_read", {}, {}, "completed", "between");
    const rows: MessagesTimelineRow[] = [
      toggle("send-1"),
      {
        kind: "work",
        id: "between",
        createdAt: "",
        groupedEntries: [between.entry],
        isExpandedToolGroup: false,
      },
      toggle("read-1"),
    ];
    // send-2 sits in the group starting at send-1; the later group shares its timestamp.
    expect(
      sendingCallRowIndex(
        rows,
        [firstSend, secondSend, between, later],
        secondSend,
        () => undefined,
      ),
    ).toBe(0);
    // A call that starts its own row after an open one is not inside a collapsed group.
    expect(
      sendingCallRowIndex(rows, [firstSend, between, secondSend], secondSend, () => undefined),
    ).toBe(-1);
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
    expect(sendingCallRowIndex(rows, [], secondSend, () => "run-1:steer:s1")).toBe(1);
  });
});
