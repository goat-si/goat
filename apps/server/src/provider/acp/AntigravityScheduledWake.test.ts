import { expect, it } from "@effect/vitest";
import { parseSessionUpdateEvent } from "@goat/provider-acp/server/runtimeModel";
import {
  antigravityToolOutlivesPrompt,
  normalizeAntigravityToolCall,
} from "./AntigravityProtocol.ts";

it.each([
  { title: "Run schedule", kind: "other", input: {}, expected: true },
  { title: "Running schedule", kind: "other", input: {}, expected: true },
  { title: "Run list_dir", kind: "other", input: {}, expected: false },
  { title: "run", kind: "execute", input: {}, expected: true },
  { title: "run", kind: "execute", input: { IsDaemon: true }, expected: false },
] as const)(
  "classifies $title as holding the turn: $expected",
  ({ title, kind, input, expected }) => {
    const event = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call",
        status: "in_progress",
        title,
        kind,
        rawInput: input,
      },
    }).events.find((item) => item._tag === "ToolCallUpdated");
    expect(
      event?._tag === "ToolCallUpdated" &&
        antigravityToolOutlivesPrompt(normalizeAntigravityToolCall(event.toolCall)),
    ).toBe(expected);
  },
);
