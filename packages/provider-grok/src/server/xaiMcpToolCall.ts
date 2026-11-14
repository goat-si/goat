import type { AcpToolCallState } from "@goat/provider-acp/server/runtimeModel";

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Grok calls MCP tools through its `use_tool` built-in as "<server>__<tool>" and wraps results as
// { type: "MCP", output: { OkayOutput } | { Error } }; rewrite both into the generic ACP MCP shapes.
export function normalizeXAiMcpToolCall(toolCall: AcpToolCallState): AcpToolCallState {
  const meta = unknownRecord(toolCall.data.meta);
  const rawInput = unknownRecord(toolCall.data.rawInput);
  const toolName = nonEmptyString(rawInput?.tool_name) ?? "";
  const separator = toolName.indexOf("__");
  const isUseTool =
    unknownRecord(meta?.["x.ai/tool"])?.name === "use_tool" &&
    separator > 0 &&
    separator + 2 < toolName.length;
  const rawOutput = unknownRecord(toolCall.data.rawOutput);
  const result = rawOutput?.type === "MCP" ? unknownRecord(rawOutput.output) : undefined;
  const text =
    typeof result?.Error === "string"
      ? result.Error
      : typeof result?.OkayOutput === "string"
        ? result.OkayOutput
        : undefined;
  if (!isUseTool && text === undefined) return toolCall;
  return {
    ...toolCall,
    data: {
      ...toolCall.data,
      ...(isUseTool
        ? {
            meta: { ...meta, is_mcp_tool_call: true },
            rawInput: {
              server: toolName.slice(0, separator),
              tool: toolName.slice(separator + 2),
              arguments: unknownRecord(rawInput?.tool_input) ?? {},
            },
          }
        : {}),
      ...(text === undefined
        ? {}
        : {
            rawOutput: {
              ...(typeof result?.Error === "string" ? { isError: true } : {}),
              content: [{ type: "text", text }],
            },
          }),
    },
  };
}
