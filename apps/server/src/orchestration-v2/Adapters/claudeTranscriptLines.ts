import type { SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { field } from "../unknownField.ts";

const decodeClaudeTranscriptLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.String })),
);

export const isClaudeConversationLine = (line: string): boolean =>
  Option.match(decodeClaudeTranscriptLine(line), {
    onNone: () => false,
    onSome: (entry) => entry.type === "user" || entry.type === "assistant",
  });

/** Claude writes blocks separately with stop_reason null until the last.
 * Missing stop_reason keeps the turn open; pre-tool text is not the reply. */
export function isClaudeTranscriptTurnEnd(entry: unknown): boolean {
  if (field(entry, "type") !== "assistant") return false;
  const stopReason = field(field(entry, "message"), "stop_reason");
  return typeof stopReason === "string" && stopReason !== "tool_use";
}

export function isClaudeTranscriptConversationLine(
  entry: unknown,
): entry is SDKAssistantMessage | SDKUserMessage {
  const type = field(entry, "type");
  const content = field(field(entry, "message"), "content");
  return (
    typeof field(entry, "uuid") === "string" &&
    ((type === "assistant" && Array.isArray(content)) ||
      (type === "user" && (Array.isArray(content) || typeof content === "string")))
  );
}
