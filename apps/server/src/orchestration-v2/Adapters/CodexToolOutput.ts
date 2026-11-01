import { imageBlockFromDataUrl, mcpToolResultOutput } from "@goat/shared/toolOutput";
import type * as CodexSchema from "effect-codex-app-server/schema";

type CodexToolItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "mcpToolCall" | "dynamicToolCall" }
>;

function codexMcpToolOutput(
  item: Extract<CodexToolItem, { readonly type: "mcpToolCall" }>,
): unknown | undefined {
  const resultOutput =
    item.result === null || item.result === undefined
      ? undefined
      : mcpToolResultOutput(item.result);
  if (item.error === null || item.error === undefined) {
    return resultOutput;
  }
  return resultOutput === undefined
    ? { error: item.error.message }
    : { error: item.error.message, result: resultOutput };
}

// Codex hands a dynamic tool's image back as a data URL; the timeline reads image blocks.
function codexDynamicToolOutput(
  item: Extract<CodexToolItem, { readonly type: "dynamicToolCall" }>,
): unknown | undefined {
  if (item.contentItems !== null && item.contentItems !== undefined) {
    return item.contentItems.map((contentItem) =>
      contentItem.type === "inputImage"
        ? (imageBlockFromDataUrl(contentItem.imageUrl) ?? contentItem)
        : contentItem,
    );
  }
  return item.success === false ? { success: false } : undefined;
}

/** The output a Codex MCP or dynamic tool call stores on its turn item. */
export function codexToolOutput(item: CodexToolItem): unknown | undefined {
  return item.type === "mcpToolCall" ? codexMcpToolOutput(item) : codexDynamicToolOutput(item);
}
