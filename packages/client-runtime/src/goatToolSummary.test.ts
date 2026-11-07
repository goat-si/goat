import { describe, expect, it } from "vite-plus/test";
import { resolveGoatMcpToolDefinition } from "@goat/shared/goatMcpToolPresentation";

import { summarizeGoatToolCalls, type GoatToolSummaryCall } from "./goatToolSummary.ts";

function completed(input: unknown, output?: unknown): GoatToolSummaryCall {
  return { input, output, outcome: "completed" };
}

describe("summarizeGoatToolCalls", () => {
  it("counts the pull requests batch link and unlink calls changed", () => {
    const urls = ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/1", "not-a-pr"];
    const links = completed({ urls }, { linkedCount: 1 });
    expect(summarizeGoatToolCalls("link-pr", [links, completed({ number: 3 })]).label).toBe(
      "Linked 2 pull requests",
    );
    expect(summarizeGoatToolCalls("link-pr", [completed({ urls }, {})]).label).toBe(
      "Linked pull requests",
    );
    const batch = completed({ states: ["merged"] }, { unlinkedCount: 2 });
    expect(summarizeGoatToolCalls("unlink-pr", [batch, completed({ number: 3 })]).label).toBe(
      "Unlinked 3 pull requests",
    );
    const uncounted = completed({ states: ["merged"] }, { isError: false });
    expect(summarizeGoatToolCalls("unlink-pr", [uncounted]).label).toBe("Unlinked pull requests");
  });

  it("describes an accepted merge request without claiming it merged", () => {
    expect(
      summarizeGoatToolCalls("write-pr", [completed({ auto: true }, { status: "accepted" })]),
    ).toEqual({ label: "Accepted 1 pull request change", failedCount: 0 });
  });
  it("says GOAT Bot moved only when the claim won", () => {
    const claim = (claimed: boolean) =>
      completed({}, { claimed, home: { environmentId: "env", claimedAt: 1, claimId: "c" } });
    expect(summarizeGoatToolCalls("channel-bot-home-claim", [claim(true)]).label).toBe(
      "Moved GOAT Bot to this machine",
    );
    expect(summarizeGoatToolCalls("channel-bot-home-claim", [claim(false)]).label).toBe(
      "Tried to move GOAT Bot to this machine",
    );
  });

  it("never says GOAT Bot's notes changed when the request was refused", () => {
    const refused = completed(
      { kind: "remember", quote: "remember that staging is staging-02" },
      { outcome: "refused", reason: "busy", told: true, message: "Not changed." },
    );
    const notes = resolveGoatMcpToolDefinition("goat_channel_notes_change");
    expect(notes?.labels[2]).toBe("Requested");
    expect(summarizeGoatToolCalls(notes!.summaryAction, [refused]).label).toBe(
      "Requested GOAT Bot notes changes 1 time",
    );
  });

  it("describes continuing work on another machine", () => {
    expect(
      summarizeGoatToolCalls("channel-task-move", [completed({ taskId: "task-1", host: "mini" })])
        .label,
    ).toBe("Continued GOAT tasks on another machine 1 time");
  });

  it("reads provider result envelopes without treating JSON in the message as result data", () => {
    const result = { messageId: "message-1", threadId: "actual-thread" };
    const json = JSON.stringify(result);
    const outputs = [
      result,
      { structuredContent: result },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ];
    const calls = outputs.map((output) =>
      completed(
        {
          toolName: "goat_thread_send",
          args: { threadId: "input-thread", message: '{"threadId":"fake"}' },
        },
        output,
      ),
    );
    expect(summarizeGoatToolCalls("thread-send", calls).label).toBe("Sent 1 message to 1 thread");
    expect(
      summarizeGoatToolCalls("thread-send", [
        completed({ toolName: "goat_thread_send", args: { threadId: "input-thread" } }),
        completed({ threadId: "input-thread" }),
      ]).label,
    ).toBe("Sent 2 messages to 1 thread");
  });

  it("excludes failed and unfinished sends even if the provider reports completed", () => {
    const calls: GoatToolSummaryCall[] = [
      completed({ threadId: "success" }, { messageId: "ok", threadId: "success" }),
      completed(
        { threadId: "failed" },
        { isError: true, structuredContent: { threadId: "failed" } },
      ),
      completed({ threadId: "failed" }, [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure" }) },
      ]),
      { input: { threadId: "cancelled" }, output: undefined, outcome: "unfinished" },
    ];
    expect(summarizeGoatToolCalls("thread-send", calls)).toEqual({
      label: "Sent 1 message to 1 thread",
      failedCount: 2,
    });
    expect(summarizeGoatToolCalls("thread-send", [calls[1]!])).toEqual({
      label: "Tried to send 1 message to 1 thread",
      failedCount: 1,
    });
  });

  it("does not confuse a child's failure or wait timeout with failure of the orchestration call", () => {
    const failedChild = { taskId: "task-1", status: "failed", summary: "command not found" };
    expect(
      summarizeGoatToolCalls("delegate", [completed({}, failedChild), completed({}, failedChild)]),
    ).toEqual({
      label: "Delegated 1 task",
      failedCount: 0,
    });
    expect(
      summarizeGoatToolCalls(
        "task-status",
        Array.from({ length: 4 }, () => completed({ taskId: "task-1" }, failedChild)),
      ).label,
    ).toBe("Checked task status 4 times");
    expect(
      summarizeGoatToolCalls("thread-wait", [
        completed({ threadId: "thread-1" }, { threadId: "thread-1", timedOut: true }),
      ]),
    ).toEqual({
      label: "Waited on 1 thread",
      failedCount: 0,
    });
  });

  it("names a host status read the same way the tool card does", () => {
    expect(summarizeGoatToolCalls("host-status", [completed({})]).label).toBe(
      "Read host status 1 time",
    );
    expect(
      summarizeGoatToolCalls("host-status", [{ input: {}, output: {}, outcome: "failed" }]).label,
    ).toBe("Tried to read host status 1 time");
  });
});
