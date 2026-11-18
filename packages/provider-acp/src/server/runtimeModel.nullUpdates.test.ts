import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpSchema from "effect-acp/compat";
import { mergeToolCallState, parseSessionUpdateEvent } from "./runtimeModel.ts";

describe("ACP tool updates", () => {
  it("clears explicitly nulled ACP v2 tool call fields and replaces raw input", () => {
    const toolCall = (update: Omit<EffectAcpSchema.ToolCallUpdate, "toolCallId">) => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", ...update },
      } satisfies EffectAcpSchema.SessionNotification);
      const event = parsed.events.find((candidate) => candidate._tag === "ToolCallUpdated");
      if (!event || event._tag !== "ToolCallUpdated") {
        throw new Error("expected a tool call update");
      }
      return event.toolCall;
    };

    const created = toolCall({
      name: "old-name",
      title: "Old title",
      kind: "read",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "old output" } }],
      rawInput: { path: "old.txt", obsolete: true },
      _meta: { old: true },
    });

    expect(
      mergeToolCallState(created, toolCall({ rawInput: { path: "new.txt" } })).data.rawInput,
    ).toEqual({ path: "new.txt" });

    const cleared = mergeToolCallState(
      created,
      toolCall({
        name: null,
        title: null,
        kind: null,
        status: null,
        content: null,
        rawInput: null,
        _meta: null,
      }),
    );
    const { name, title, kind, content, rawInput, meta } = cleared.data;
    expect({ name, title, kind, content, rawInput, meta }).toEqual({});
    expect({ kind: cleared.kind, title: cleared.title, status: cleared.status }).toEqual({});
  });
});
