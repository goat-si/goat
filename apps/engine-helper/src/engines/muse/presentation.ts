// Adapted from provider-muse/src/server/itemPresentation.ts:42-145 and adapter.ts:650-724.
import { assistantMessage, item, reasoning } from "../../items.ts";
import type { HelperItem } from "../../protocol.ts";

type NativeItem = Record<string, any>;
export function projectMuseItem(native: NativeItem, turnId: string, id: string, now: string, instanceId: string): HelperItem | undefined {
  const status = native.status === "completed" ? "completed" : native.status === "cancelled" ? "cancelled" : "failed";
  const base = { id, turnId, driver: "muse", nativeId: String(native.itemId), now, status, title: native.tool ?? null } as const;
  const text = native.text ?? native.summary?.join("\n") ?? native.fallbackText ?? "";
  if (native.kind === "agentMessage") return assistantMessage(base, text);
  if (native.kind === "reasoning") return reasoning(base, text);
  if (native.kind === "userMessage" || native.kind === "reminderChild") return undefined;
  if (native.kind === "toolCall" && ["write_todos", "request_user_input", "workflow"].includes(native.tool) && native.status !== "failed") return undefined;
  if (native.kind === "subagent") return item(base, "subagent", { subagentId: native.subagentId ?? native.itemId, origin: "provider_native", driver: "muse", providerInstanceId: instanceId, childThreadId: null, prompt: native.objective ?? native.role ?? "Muse agent", result: native.result?.summary ?? null });
  if (native.kind === "compaction") return item(base, "compaction", { driver: "muse", summary: text || native.reason });
  let args: Record<string, any> = {};
  try { const parsed = JSON.parse(native.args ?? "{}"); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed; } catch { /* Streaming arguments can be incomplete in v1. */ }
  const str = (...keys: string[]) => keys.map((key) => args[key]).find((value) => typeof value === "string") as string | undefined;
  const tool = String(native.tool ?? native.kind);
  if (native.kind === "userShell" || /shell|bash|exec_command/i.test(tool)) return item(base, "command_execution", { input: native.commandText ?? str("command", "cmd") ?? native.args ?? "", outputOmitted: true, ...(typeof native.exitCode === "number" ? { exitCode: native.exitCode } : {}) });
  const path = str("file_path", "path", "filePath")?.trim();
  if (native.kind === "toolCall" && /write|edit|patch/i.test(tool) && path) return item(base, "file_change", { fileName: path, patchOmitted: true });
  if (native.kind === "toolCall" && /web|browse|fetch/i.test(tool)) {
    const query = str("query", "url", "pattern")?.trim();
    let results: Array<{ url?: string; title?: string; snippet?: string }> = [];
    try { const parsed = JSON.parse(native.visibleOutput ?? "{}"); if (Array.isArray(parsed.results)) results = parsed.results.map((v: any) => ({ ...(typeof v.url === "string" ? { url: v.url } : {}), ...(typeof v.title === "string" ? { title: v.title } : {}), ...(typeof v.snippet === "string" ? { snippet: v.snippet } : {}) })); } catch { /* optional result detail */ }
    return item(base, "web_search", { ...(query ? { patterns: [query] } : {}), ...(results.length ? { results } : {}) });
  }
  return item(base, "dynamic_tool", { toolName: tool, input: args, outputOmitted: true, toolSummary: native.result?.summary ?? native.finalSummary ?? native.fallbackText ?? "" });
}
