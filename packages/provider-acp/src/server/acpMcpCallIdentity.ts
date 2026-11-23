import { GOAT_MCP_TOOL_NAMES } from "@goat/shared/goatMcpToolPresentation";
import { acpMcpFallbackInput, hermesGoatTool, ompDeviceGoatToolCall } from "./acpMcpCallInput.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AcpMcpToolCallIdentity {
  readonly server: string;
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

const ACP_MCP_FALLBACK_CALL = /(?:^|[\s"'=])acp-mcp-call[\s"']+([A-Za-z0-9_.-]+)(?:\s+(.+?))?\s*$/u;

/**
 * GOAT always injects its server as "goat", and matches are additionally gated on the known GOAT
 * tool inventory, so the separator match can stay loose.
 */
const GOAT_MCP_TITLE_CALL =
  /^(?:@|mcp[-_]{1,2})?goat[-_.:/ ]{1,3}(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*)(?::.*)?$/i;

/**
 * Gemini CLI titles injected MCP calls "<tool> (<server> MCP Server)" and
 * qwen-code appends ": <args json>" to the same template; Auggie namespaces
 * tool-first as "<tool>_goat".
 */
const GOAT_MCP_TITLE_SUFFIX_CALL =
  /^(?<tool>[A-Za-z0-9][A-Za-z0-9_.-]*?)(?: \(goat MCP Server\)(?::|$)|[-_.]goat$)/i;

/**
 * glm and Kimi use bare names; Antigravity uses "Running <tool>". Kimi appends
 * streamed JSON arguments. Require a name or JSON opening brace so built-ins
 * titled "<tool>: <description>" cannot impersonate an inventory entry.
 */
const GOAT_MCP_BARE_TITLE_CALL = /^(?<tool>[A-Za-z0-9_]+)(?::\s*\{|$)/;
const ANTIGRAVITY_TOOL_TITLE = /^Run(?:ning)? (?<name>[^\s?]+)\??$/;

/**
 * ACP has no typed MCP tool-call item, so agents surface MCP calls in agent-specific shapes:
 * codex-acp tags execute calls with `rawInput.server`/`rawInput.tool`, while agents on GOAT's
 * terminal fallback run the `acp-mcp-call <tool>` CLI through their command or an embedded client
 * terminal.
 */
export function extractMcpToolCallIdentity(
  toolCall: AcpToolCallState,
  options?: {
    readonly embeddedTerminalCommands?: ReadonlyArray<string>;
  },
): AcpMcpToolCallIdentity | undefined {
  const rawInput = isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  const meta = isRecord(toolCall.data.meta) ? toolCall.data.meta : undefined;
  const server = typeof rawInput?.server === "string" ? rawInput.server.trim() : "";
  const tool = typeof rawInput?.tool === "string" ? rawInput.tool.trim() : "";
  if (meta?.is_mcp_tool_call === true && server.length > 0 && tool.length > 0) {
    return { server, tool };
  }
  // Antigravity reaches MCP tools its context budget left out through call_mcp_tool, an execute
  // call titled "MCP Tool <tool>" whose rawInput names the server, tool, and arguments.
  const proxiedServer = typeof rawInput?.ServerName === "string" ? rawInput.ServerName.trim() : "";
  const proxiedTool = typeof rawInput?.ToolName === "string" ? rawInput.ToolName.trim() : "";
  if (proxiedServer.length > 0 && proxiedTool.length > 0) {
    const input = isRecord(rawInput?.Arguments) ? rawInput.Arguments : undefined;
    return { server: proxiedServer, tool: proxiedTool, ...(input === undefined ? {} : { input }) };
  }
  const claudeCode = isRecord(meta?.claudeCode) ? meta.claudeCode : undefined;
  const gooseToolCall = isRecord(meta?.goose)
    ? isRecord(meta.goose.toolCall)
      ? meta.goose.toolCall
      : undefined
    : undefined;
  const metaServerId = typeof meta?.serverId === "string" ? meta.serverId.trim() : "";
  const metaToolName = typeof meta?.toolName === "string" ? meta.toolName.trim() : "";
  if (/^goat$/i.test(metaServerId) && metaToolName.length > 0) {
    for (const knownTool of GOAT_MCP_TOOL_NAMES) {
      const boundary = metaToolName.length - knownTool.length - 1;
      if (
        metaToolName === knownTool ||
        (metaToolName.endsWith(knownTool) &&
          boundary >= 0 &&
          !/[A-Za-z0-9]/.test(metaToolName.charAt(boundary)))
      ) {
        return { server: "goat", tool: knownTool };
      }
    }
  }
  const gooseExtension =
    typeof gooseToolCall?.extensionName === "string" ? gooseToolCall.extensionName.trim() : "";
  const assertsForeignOrigin =
    (metaServerId.length > 0 && !/^goat$/i.test(metaServerId)) ||
    (gooseExtension.length > 0 && !/^goat$/i.test(gooseExtension));
  // qwen's serverId marks a real MCP server, but goose reports its built-in
  // extensions (developer__shell, edits) the same way as user MCP servers, so
  // goose stays unclassified and keeps its command and file-change projections.
  if (assertsForeignOrigin) {
    if (metaServerId.length === 0 || metaToolName.length === 0) return undefined;
    const prefix = [`mcp__${metaServerId}__`, `mcp::${metaServerId}::`].find((prefix) =>
      metaToolName.startsWith(prefix),
    );
    const tool = prefix === undefined ? metaToolName : metaToolName.slice(prefix.length);
    return tool ? { server: metaServerId, tool } : undefined;
  }
  const deviceCall = ompDeviceGoatToolCall(rawInput, GOAT_MCP_TITLE_CALL);
  if (deviceCall !== undefined) return { server: "goat", ...deviceCall };
  const candidates = [
    meta?.toolName,
    claudeCode?.toolName,
    gooseToolCall?.toolName,
    toolCall.data.title,
  ].filter((value): value is string => typeof value === "string");
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const qualified = /^mcp__(.+?)__(.+)$/i.exec(trimmed);
    const hermesTool = hermesGoatTool(qualified?.[1], qualified?.[2]);
    if (hermesTool !== undefined) return { server: "goat", tool: hermesTool };
    if (qualified?.[1] && qualified[2] && !/^goat$/i.test(qualified[1]))
      return { server: qualified[1], tool: qualified[2] };
    // The server key and the tool prefix are both "goat", so "goat_thread_send"
    // also reads as server "goat" + tool "thread_send". Try every convention and
    // keep the first one that names a known tool.
    const name = ANTIGRAVITY_TOOL_TITLE.exec(trimmed)?.groups?.name ?? trimmed;
    for (const convention of [
      GOAT_MCP_TITLE_CALL,
      GOAT_MCP_TITLE_SUFFIX_CALL,
      GOAT_MCP_BARE_TITLE_CALL,
    ]) {
      const candidateTool = convention.exec(name)?.groups?.tool;
      if (candidateTool !== undefined && GOAT_MCP_TOOL_NAMES.has(candidateTool)) {
        return { server: "goat", tool: candidateTool };
      }
    }
  }
  const commands = [
    ...(toolCall.command === undefined ? [] : [toolCall.command]),
    // pi-acp reports the exec command line only as the verbatim title.
    ...(typeof toolCall.data.title === "string" ? [toolCall.data.title] : []),
    ...(options?.embeddedTerminalCommands ?? []),
  ];
  for (const command of commands) {
    const match = ACP_MCP_FALLBACK_CALL.exec(command);
    if (match?.[1] !== undefined) {
      const input = acpMcpFallbackInput(match[2]);
      return { server: "goat", tool: match[1], ...(input === undefined ? {} : { input }) };
    }
  }
  return undefined;
}
