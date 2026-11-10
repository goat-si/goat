import { GOAT_MCP_TOOL_NAMES } from "@goat/shared/goatMcpToolPresentation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function acpMcpFallbackInput(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const candidates = [
    trimmed,
    ...(trimmed.startsWith("'") && trimmed.endsWith("'") ? [trimmed.slice(1, -1)] : []),
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const unwrapped = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
      if (isRecord(unwrapped)) return unwrapped;
    } catch {
      // Unknown shell quoting retains MCP identity but omits unparseable input.
    }
  }
  return undefined;
}

/**
 * OMP mounts MCP tools as xd://mcp__<server>_<tool> devices and calls them by writing JSON args;
 * a read of the same path only fetches the tool's docs.
 */
export function ompDeviceGoatToolCall(
  rawInput: Record<string, unknown> | undefined,
  titleCall: RegExp,
): { readonly tool: string; readonly input?: Record<string, unknown> } | undefined {
  const devicePath = typeof rawInput?.path === "string" ? rawInput.path : "";
  if (!devicePath.startsWith("xd://") || typeof rawInput?.content !== "string") return undefined;
  const tool = titleCall.exec(devicePath.slice("xd://".length))?.groups?.tool;
  if (tool === undefined || !GOAT_MCP_TOOL_NAMES.has(tool)) return undefined;
  const input = acpMcpFallbackInput(rawInput.content);
  return { tool, ...(input === undefined ? {} : { input }) };
}
