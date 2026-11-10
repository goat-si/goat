import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";
import {
  extractMcpToolCallIdentity,
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "./runtimeModel.ts";

function toolCallFromUpdate(
  update: EffectAcpSchema.SessionNotification["update"],
): AcpToolCallState {
  const parsed = parseSessionUpdateEvent({ sessionId: "session-1", update });
  const event = parsed.events.find(
    (
      candidate,
    ): candidate is Extract<(typeof parsed.events)[number], { _tag: "ToolCallUpdated" }> =>
      candidate._tag === "ToolCallUpdated",
  );
  if (event === undefined) throw new Error("expected a tool call event");
  return event.toolCall;
}

describe("extractMcpToolCallIdentity for OMP devices", () => {
  // regression: #33667 OMP mounts MCP tools as xd:// devices and calls them through `write`.
  it("recovers GOAT identity from OMP xd:// device writes but not its doc reads", () => {
    const args = {
      html: '<svg width="320" height="120"><rect width="300" height="100" fill="#4f46e5"/></svg>',
      title: "Static SVG",
    };
    const result = {
      htmlRender: { attachmentId: "synthetic-attachment-html", title: "Static SVG", height: 136 },
      message: "Shown to the reader above your reply.",
    };
    const text = JSON.stringify(result);
    const created = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_015ATZG99gw99Rrp4htieLux",
      title: "Rendering static SVG",
      kind: "execute",
      status: "pending",
      rawInput: { path: "xd://mcp__goat_html_render", content: JSON.stringify(args) },
    });
    const completed = mergeToolCallState(
      created,
      toolCallFromUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_015ATZG99gw99Rrp4htieLux",
        status: "completed",
        rawOutput: {
          content: [{ type: "text", text }],
          details: {
            xdev: {
              tool: "mcp__goat_html_render",
              mode: "execute",
              args,
              tier: "write",
              inner: {
                serverName: "goat",
                mcpToolName: "html_render",
                rawContent: [{ type: "text", text }],
                provider: "acp",
                providerName: "ACP Client",
                structuredContent: result,
              },
            },
          },
        },
        content: [{ type: "content", content: { type: "text", text } }],
      }),
    );
    const docRead = toolCallFromUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_read",
      title: "Reading html_render schema",
      kind: "read",
      status: "pending",
      rawInput: { path: "xd://mcp__goat_html_render" },
    });

    const expected = { server: "goat", tool: "html_render", input: args };
    expect(extractMcpToolCallIdentity(created), "pending write").toEqual(expected);
    expect(extractMcpToolCallIdentity(completed), "completed write").toEqual(expected);
    expect(extractMcpToolCallIdentity(docRead), "doc read").toBeUndefined();
  });
});
