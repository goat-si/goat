import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";
import {
  parseSessionUpdateEvent,
  mergeToolCallState,
  extractMcpToolCallIdentity,
} from "./runtimeModel.ts";

describe("ACP regressions", () => {
  const toolCallFromUpdate = (update: EffectAcpSchema.SessionNotification["update"]) => {
    const event = parseSessionUpdateEvent({ sessionId: "session-1", update }).events.find(
      (entry) => entry._tag === "ToolCallUpdated",
    );
    if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call event");
    return event.toolCall;
  };
  it("projects ACP v2 compaction lifecycle and prompt usage", () => {
    const compacting = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "in_progress",
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const compacted = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "compaction_update",
        compactionId: "compact-1",
        status: "completed",
        summary: [{ type: "text", text: "Retained the implementation decisions." }],
      },
    } satisfies EffectAcpSchema.SessionNotification);
    const idle = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
        usage: { totalTokens: 420, inputTokens: 300, outputTokens: 100, thoughtTokens: 20 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(compacting.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "acp-compaction:compact-1",
        kind: "think",
        title: "Compact context",
        status: "inProgress",
      },
    });
    expect(compacted.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "acp-compaction:compact-1",
        status: "completed",
        data: { rawOutput: "Retained the implementation decisions." },
      },
    });
    expect(idle.events).toEqual([]);

    const toolCall = (update: EffectAcpSchema.SessionUpdate) => {
      const event = parseSessionUpdateEvent({ sessionId: "session-1", update }).events[0];
      if (event?._tag !== "ToolCallUpdated") throw new Error("expected a compaction tool call");
      return event.toolCall;
    };
    const draft = toolCall({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "compact-1",
      content: { type: "text", text: "Draft summary" },
    });
    const finish = (summary?: ReadonlyArray<EffectAcpSchema.ContentBlock> | null) =>
      mergeToolCallState(
        draft,
        toolCall({
          sessionUpdate: "compaction_update",
          compactionId: "compact-1",
          status: "completed",
          ...(summary === undefined ? {} : { summary }),
        }),
      ).data.rawOutput;

    expect(finish()).toBe("Draft summary");
    expect([finish(null), finish([]), finish([{ type: "text", text: "" }])]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const fail = (
      previous: ReturnType<typeof toolCall>,
      patch: Pick<
        Extract<EffectAcpSchema.SessionUpdate, { sessionUpdate: "compaction_update" }>,
        "summary" | "error"
      >,
    ) =>
      mergeToolCallState(
        previous,
        toolCall({
          sessionUpdate: "compaction_update",
          compactionId: "compact-1",
          status: "failed",
          ...patch,
        }),
      );
    const failed = fail(draft, { error: "Budget exhausted" });
    const summaryCleared = fail(failed, { summary: null });
    const errorCleared = fail(summaryCleared, { error: null });
    const fields = (state: ReturnType<typeof toolCall>) => [
      state.data.rawOutput,
      state.data.compactionError,
    ];
    expect(fields(failed)).toEqual(["Draft summary", "Budget exhausted"]);
    expect(fields(summaryCleared)).toEqual([undefined, "Budget exhausted"]);
    expect(fields(errorCleared)).toEqual([undefined, undefined]);
    expect(fields(fail(draft, { summary: null, error: "Budget exhausted" }))).toEqual([
      undefined,
      "Budget exhausted",
    ]);
  });

  it("recovers server, tool, and arguments from Antigravity call_mcp_tool calls", () => {
    // agy 1.5.12 reaches MCP tools its context budget left out through call_mcp_tool.
    const toolCall = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call_13347576314095519317",
      kind: "execute",
      title: "MCP Tool navigate_page",
      status: "in_progress",
      rawInput: {
        ServerName: "chrome-devtools",
        ToolName: "navigate_page",
        Arguments: { url: "https://example.com" },
      },
    });

    expect(extractMcpToolCallIdentity(toolCall)).toEqual({
      server: "chrome-devtools",
      tool: "navigate_page",
      input: { url: "https://example.com" },
    });
  });
});
