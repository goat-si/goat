import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_CODE_PRESET_TOOLS = {
  type: "preset",
  preset: "claude_code",
} satisfies NonNullable<ClaudeQueryOptions["tools"]>;
export type ClaudeAgentSdkQueryToolList = ReadonlyArray<string>;
export interface ClaudeAgentSdkQueryPresetTools {
  readonly type: "preset";
  readonly preset: "claude_code";
}
export type ClaudeAgentSdkQueryTools = ClaudeAgentSdkQueryToolList | ClaudeAgentSdkQueryPresetTools;
export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;
export function claudeAgentSdkQueryToolsForSdk(
  tools: ClaudeAgentSdkQueryTools,
): NonNullable<ClaudeQueryOptions["tools"]> {
  if (isClaudeAgentSdkQueryToolList(tools)) {
    return [...tools];
  }
  return { type: tools.type, preset: tools.preset };
}
function isClaudeAgentSdkQueryToolList(
  tools: ClaudeAgentSdkQueryTools,
): tools is ClaudeAgentSdkQueryToolList {
  return Array.isArray(tools);
}
