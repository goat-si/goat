import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function claudeWakeBufferDetail(messages: ReadonlyArray<SDKMessage>): string | null {
  return (
    messages
      .flatMap((entry) =>
        entry.type === "system" &&
        entry.subtype === "task_notification" &&
        typeof entry.summary === "string" &&
        entry.summary.length > 0
          ? [entry.summary]
          : [],
      )
      .at(-1) ?? null
  );
}
