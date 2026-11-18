import type { OrchestrationV2AppThread } from "@goat/contracts";

export function claudeQueryFlagEnvironment(input: {
  readonly environment: Readonly<Record<string, string>> | undefined;
  readonly pinnedAlias: string | undefined;
  readonly autoCompactWindow: string | undefined;
  readonly toolSearchOverride: "true" | undefined;
}) {
  return {
    ...input.environment,
    ...(input.autoCompactWindow === undefined
      ? {}
      : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: input.autoCompactWindow }),
    ...(input.pinnedAlias === undefined
      ? {}
      : { [`ANTHROPIC_DEFAULT_${input.pinnedAlias.toUpperCase()}_MODEL`]: input.pinnedAlias }),
    ...(input.toolSearchOverride === undefined
      ? {}
      : { ENABLE_TOOL_SEARCH: input.toolSearchOverride }),
  };
}

const CLAUDE_SCIENTIFIC_INTEGER = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;
const CLAUDE_GROUPED_INTEGER = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/;
// Claude Code 2.1.310's integer parsing for auto:N. Scientific notation counts only when it is an
// integer, grouped digits (1_000, 1,000, or 1 000) are joined, and anything else uses parseInt.
function parseClaudeInteger(text: string): number {
  const value = text.trim();
  if (value.length <= 32 && CLAUDE_SCIENTIFIC_INTEGER.test(value)) {
    const number = Number(value);
    return Number.isInteger(number) ? number : Number.NaN;
  }
  if (value.length <= 32 && CLAUDE_GROUPED_INTEGER.test(value)) {
    return Number.parseInt(value.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  }
  return Number.parseInt(value, 10);
}

// A delegated child is its own SDK session, so Claude Code gives it the main-conversation cache
// TTL. When the user sets Claude's subagentPromptCacheTtl, the child follows it like a native
// subagent would. A resumed session's first request otherwise goes out before its MCP servers
// connect, and Claude Code tells the agent they disconnected. Explicit instance values still win.
export function claudeQueryEnvironment(
  environment: NodeJS.ProcessEnv,
  appThread: Pick<OrchestrationV2AppThread, "lineage">,
  subagentPromptCacheTtl: "5m" | "1h" | undefined,
  resume = false,
): NodeJS.ProcessEnv {
  const promptCacheTtl =
    appThread.lineage.relationshipToParent === "subagent" &&
    subagentPromptCacheTtl !== undefined &&
    environment.CLAUDE_CODE_PROMPT_CACHE_TTL === undefined
      ? subagentPromptCacheTtl
      : undefined;
  const blockingMcpConnect = resume && environment.MCP_CONNECTION_NONBLOCKING === undefined;
  if (promptCacheTtl === undefined && !blockingMcpConnect) {
    return environment;
  }
  return {
    ...environment,
    ...(promptCacheTtl === undefined ? {} : { CLAUDE_CODE_PROMPT_CACHE_TTL: promptCacheTtl }),
    ...(blockingMcpConnect ? { MCP_CONNECTION_NONBLOCKING: "0" } : {}),
  };
}

// Claude Code's auto tool search sends every MCP schema in full while they fit under a share of the
// context window, which GOAT's tools do on 1M models. auto:0 already means on and auto:100 off.
export function claudeToolSearchOverride(value: string | undefined): "true" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return "true";
  if (!value.startsWith("auto:")) return undefined;
  const percent = parseClaudeInteger(value.slice("auto:".length));
  // Claude Code treats an unparsable auto:N as auto, and clamps N to 0..100.
  if (Number.isNaN(percent)) return "true";
  const clamped = Math.min(100, Math.max(0, percent));
  return clamped > 0 && clamped < 100 ? "true" : undefined;
}
