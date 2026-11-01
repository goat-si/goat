import type { ToolCall } from "@cursor/sdk";
import { readToolOutputImage } from "@goat/shared/toolOutput";

/**
 * Cursor nests an MCP image as `{ image }`; it becomes the standard image block so the
 * timeline shows the screenshot the model saw.
 */
function cursorMcpContentPart(part: {
  readonly image?: { readonly data: string; readonly mimeType?: string | undefined } | undefined;
}): unknown {
  if (part.image?.mimeType === undefined) return part;
  const block = { type: "image", mimeType: part.image.mimeType, data: part.image.data };
  return readToolOutputImage(block) === null ? part : block;
}

export function cursorToolOutput(toolCall: ToolCall): unknown {
  const result = toolCall.result;
  if (result === undefined) {
    return undefined;
  }
  if (result.status !== "success") return result.error;
  if (toolCall.type !== "mcp" || toolCall.result?.status !== "success") return result.value;
  const value = toolCall.result.value;
  return { ...value, content: value.content.map(cursorMcpContentPart) };
}
