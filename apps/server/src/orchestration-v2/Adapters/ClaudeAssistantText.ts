import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type * as DateTime from "effect/DateTime";

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];
type ToolUse = Extract<SDKAssistantMessage["message"]["content"][number], { type: "tool_use" }>;
interface TextUpdate {
  readonly nativeItemId: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly sealed?: boolean;
}
interface TextBlock {
  readonly nativeItemId: string;
  text: string;
  published: string;
  completed: boolean;
  lineFlushed: boolean;
}

export function makeClaudeAssistantTextProjector() {
  let messageId: string | null = null;
  const blocks = new Map<string, TextBlock>();
  const nextSnapshotIndex = new Map<string, number>();
  const snapshots = new Set<string>();
  const starts = new Map<string, DateTime.Utc>();
  const key = (id: string, index: number) => JSON.stringify([id, index]);
  const update = (block: TextBlock, completed: boolean, sealed = false): TextUpdate[] => {
    if (
      block.text.length === 0 ||
      (block.published === block.text && block.completed === completed)
    )
      return [];
    block.published = block.text;
    block.completed = completed;
    return [{ nativeItemId: block.nativeItemId, text: block.text, streaming: !completed, sealed }];
  };
  return {
    startedAt(id: string, now: DateTime.Utc) {
      const start = starts.get(id) ?? now;
      starts.set(id, start);
      return start;
    },
    stream(event: StreamEvent): TextUpdate[] {
      if (event.type === "message_start") {
        messageId = event.message.id;
        return [];
      }
      if (messageId === null) return [];
      if (event.type === "content_block_start") {
        if (event.content_block.type !== "text") {
          return event.content_block.type === "tool_use"
            ? [...blocks.values()]
                .filter((block) => !block.completed)
                .flatMap((block) => update(block, false, true))
            : [];
        }
        blocks.set(key(messageId, event.index), {
          nativeItemId: `${messageId}:text:${event.index}`,
          text: event.content_block.text,
          published: "",
          completed: false,
          lineFlushed: false,
        });
      }
      if (!("index" in event)) return [];
      const block = blocks.get(key(messageId, event.index));
      if (block === undefined) return [];
      if (event.type === "content_block_delta" && event.delta.type === "text_delta")
        block.text += event.delta.text;
      if (event.type === "content_block_stop") return update(block, true);
      if (!block.lineFlushed && block.text.includes("\n")) {
        block.lineFlushed = true;
        return update(block, false, true);
      }
      return [];
    },
    snapshot(message: SDKAssistantMessage): Array<TextUpdate | { toolUse: ToolUse }> {
      if (message.parent_tool_use_id || snapshots.has(message.uuid)) return [];
      snapshots.add(message.uuid);
      let index = nextSnapshotIndex.get(message.message.id) ?? 0;
      const updates: Array<TextUpdate | { toolUse: ToolUse }> = [];
      for (const [offset, content] of message.message.content.entries()) {
        const blockKey = key(message.message.id, index++);
        if (content.type === "tool_use") updates.push({ toolUse: content });
        if (content.type !== "text") continue;
        const block = blocks.get(blockKey) ?? {
          nativeItemId: offset === 0 ? message.uuid : `${message.uuid}:text:${offset}`,
          text: "",
          published: "",
          completed: false,
          lineFlushed: false,
        };
        if (content.text.length > 0) block.text = content.text;
        blocks.set(blockKey, block);
        updates.push(...update(block, true));
      }
      nextSnapshotIndex.set(message.message.id, index);
      return updates;
    },
  };
}
