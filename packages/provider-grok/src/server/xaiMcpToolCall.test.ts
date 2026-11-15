import { describe, expect, it } from "vite-plus/test";
import {
  type AcpToolCallState,
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@goat/provider-acp/server/runtimeModel";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@goat/shared/toolOutput";
import { normalizeXAiAcpToolCallState } from "./xaiAcpExtension.ts";

function parseRecordedToolCallUpdate(update: Record<string, unknown>): AcpToolCallState {
  const [event] = parseSessionUpdateEvent({
    sessionId: "01a0d660-c1bb-7842-91a3-02d91dc8b0d2",
    update,
  } as Parameters<typeof parseSessionUpdateEvent>[0]).events;
  if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call update");
  return event.toolCall;
}

describe("Grok MCP tool calls", () => {
  // regression: #23714 Recorded from Grok 1.0.77 calling stdio MCP tools through `use_tool`.
  it("rewrites use_tool MCP calls and results into the generic ACP MCP shapes", () => {
    const meta = { "x.ai/tool": { version: 1, name: "use_tool", kind: "use_tool" } };
    const grokCall = (
      toolCallId: string,
      tool: string,
      toolInput: Record<string, unknown>,
      completion: Record<string, unknown>,
    ) => {
      const rawInput = { tool_name: tool, tool_input: toolInput };
      const updates = [
        { sessionUpdate: "tool_call", toolCallId, title: "use_tool", rawInput, _meta: meta },
        {
          sessionUpdate: "tool_call_update",
          toolCallId,
          kind: "other",
          title: tool,
          rawInput: { variant: "UseTool", ...rawInput },
          _meta: meta,
        },
        { sessionUpdate: "tool_call_update", toolCallId, ...completion },
      ];
      let state: AcpToolCallState | undefined;
      for (const update of updates) {
        state = normalizeXAiAcpToolCallState(
          mergeToolCallState(state, parseRecordedToolCallUpdate(update)),
        );
      }
      return state!;
    };
    const page = { attachmentId: "abc-html", title: "T", height: 300 };

    const rendered = grokCall(
      "call-85597c6c-6fb8-4c9c-a6a8-12c4a74ebc96-1",
      "goat__html_render",
      { path: "a.html" },
      {
        status: "completed",
        rawOutput: {
          type: "MCP",
          tool_name: "html_render",
          server_name: "goat",
          output: { OkayOutput: JSON.stringify({ htmlRender: page, message: "Shown" }) },
        },
      },
    );
    expect(extractMcpToolCallIdentity(rendered)).toEqual({
      server: "goat",
      tool: "html_render",
    });
    expect(rendered.data.rawInput).toMatchObject({ arguments: { path: "a.html" } });
    expect(
      htmlRenderFromToolItem({ toolName: "goat.html_render", output: rendered.data.rawOutput }),
    ).toEqual(page);

    const failed = grokCall(
      "call-2baebdc5-2446-4ac2-9652-85f97a76a05b-2",
      "pencil__browser",
      { action: "load-page" },
      {
        status: "failed",
        rawOutput: {
          type: "MCP",
          tool_name: "browser",
          server_name: "pencil",
          output: { Error: "Page not found" },
          is_error: true,
        },
      },
    );
    expect(extractMcpToolCallIdentity(failed)).toEqual({ server: "pencil", tool: "browser" });
    expect(compactDynamicToolOutput(failed.data.rawOutput)?.isError).toBe(true);
  });
});
