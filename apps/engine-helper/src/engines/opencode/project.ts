import type { ToolPart } from "@opencode-ai/sdk/v2";
import type { EngineHost } from "../../engine.ts";
import { item } from "../../items.ts";
import type { HelperItem } from "../../protocol.ts";

// Adapted from toolItems.ts:96-135, 200-250 at 916b5ccc1b2.
export function projectTool(part: ToolPart, turnId: string, host: EngineHost, instanceId: string): HelperItem {
  const name = part.tool;
  const input = part.state.input;
  const base = { id: part.id, turnId, driver: "opencode", nativeId: part.id, now: host.now(),
    status: part.state.status === "error" ? "failed" as const : "completed" as const,
    title: "title" in part.state ? part.state.title : null };
  const norm = name.toLowerCase();
  const text = (...keys: string[]) => keys.map((key) => input[key]).find((value): value is string => typeof value === "string") ?? "";
  if (norm === "task") {
    const metadata = "metadata" in part.state ? part.state.metadata : undefined;
    const child = metadata && typeof metadata.sessionId === "string" ? metadata.sessionId : part.id;
    return item(base, "subagent", { subagentId: child, origin: "provider_native", driver: "opencode", providerInstanceId: instanceId, childThreadId: null, prompt: text("prompt"), result: null });
  }
  const mcp = norm.startsWith("mcp__") || norm.startsWith("goat_");
  if (!mcp && (norm.includes("bash") || norm.includes("shell"))) {
    return item(base, "command_execution", { input: text("command", "cmd"), outputOmitted: true });
  }
  if (!mcp && (norm.includes("edit") || norm.includes("write") || norm.includes("patch"))) {
    return item(base, "file_change", { fileName: text("filePath", "path", "file") || name, patchOmitted: true });
  }
  if (!mcp && (norm.includes("web") || norm === "codesearch" || norm === "code_search")) {
    const query = text("query", "pattern");
    return item(base, "web_search", { ...(query ? { patterns: [query] } : {}) });
  }
  // Inputs may contain credentials. Keep tool identity and title but not arbitrary input/output.
  return item(base, "dynamic_tool", { toolName: name, input: null, outputOmitted: true,
    ...(base.title ? { toolSummary: base.title } : {}) });
}
