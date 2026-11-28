import type { SessionToolFailed, SessionToolSuccess } from "@opencode/client";
import type { JsonValue } from "@goat2/contracts-rs";
import { item } from "../../items.ts";
import type { EngineEvent, HelperItem } from "../../protocol.ts";

type Completion = SessionToolSuccess | SessionToolFailed;
type RecordValue = Record<string, unknown>;

/** State accumulated from input.started/called, and identities allocated by the caller. */
export interface ToolProjectionContext {
  readonly turnId: string;
  readonly sessionId: string;
  readonly assistantMessageId: string;
  readonly toolId: string;
  readonly name: string;
  readonly input: unknown;
  readonly now: string;
  readonly startedAt?: string | null;
  readonly title?: string | null;
  /** Stable application plan ID; the caller must retain it across todo updates. */
  readonly todoPlanId?: string;
  /** Application identities, not the provider's child session ID. */
  readonly subagent?: { readonly id: string; readonly instanceId: string; readonly childThreadId: string | null };
}

const record = (v: unknown): v is RecordValue => typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown, ...keys: string[]): string | undefined => {
  if (!record(v)) return undefined;
  for (const key of keys) if (typeof v[key] === "string" && (v[key] as string).trim()) return v[key] as string;
  return undefined;
};
const number = (v: unknown, ...keys: string[]): number | undefined => {
  if (!record(v)) return undefined;
  for (const key of keys) if (typeof v[key] === "number" && Number.isFinite(v[key])) return v[key] as number;
  return undefined;
};

// Reject non-JSON inputs rather than silently changing, stringifying or leaking malformed values.
function isJson(v: unknown, ancestors = new Set<object>()): v is JsonValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object" || ancestors.has(v)) return false;
  if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
  ancestors.add(v);
  const valid = Array.isArray(v)
    ? Array.from({ length: v.length }, (_, index) => index in v && isJson(v[index], ancestors)).every(Boolean)
    : Object.values(v).every((entry) => isJson(entry, ancestors));
  ancestors.delete(v);
  return valid;
}

export function projectTodoList(metadata: unknown, context: Pick<ToolProjectionContext, "sessionId" | "turnId" | "toolId" | "todoPlanId" | "now" | "startedAt">): HelperItem | undefined {
  if (!record(metadata) || !Array.isArray(metadata.todos) || !context.todoPlanId || !context.sessionId || !context.turnId || !context.toolId) return undefined;
  const todos: unknown[] = metadata.todos;
  if (!todos.every((todo) => record(todo) && typeof todo.content === "string" &&
    (todo.status === "pending" || todo.status === "in_progress" || todo.status === "completed" || todo.status === "cancelled"))) return undefined;
  const nativeId = context.toolId;
  const steps: Extract<HelperItem, { type: "todo_list" }>["steps"] = [];
  todos.forEach((value, index) => {
    const todo = value as { content: string; status: "pending" | "in_progress" | "completed" | "cancelled" };
    if (todo.status !== "cancelled") steps.push({ id: `${nativeId}:${index + 1}`, text: todo.content.trim() || `Todo ${index + 1}`, status: todo.status === "in_progress" ? "running" : todo.status });
  });
  return item({ id: nativeId, nativeId, driver: "opencode", turnId: context.turnId, now: context.now, startedAt: context.startedAt ?? null, title: "Todo list" }, "todo_list", { planId: context.todoPlanId, steps });
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  if (!content.every((part) => record(part) && ((part.type === "text" && typeof part.text === "string") || (part.type === "file" && typeof part.uri === "string" && typeof part.mime === "string" && (part.name === undefined || typeof part.name === "string"))))) return undefined;
  return content.flatMap((part) => part.type === "text" && part.text ? [part.text as string] : []).join("\n");
}

function readOutput(output: string): string {
  const header = /^<path>[^\r\n]+<\/path>\r?\n<type>(directory|file)<\/type>\r?\n/.exec(output);
  if (!header) return output;
  const body = output.slice(header[0].length);
  const envelope = header[1] === "directory"
    ? /^<entries>\r?\n([\s\S]*?)\r?\n<\/entries>(?=\r?\n|$)/.exec(body)
    : /^<content>(?:\r?\n)?([\s\S]*?)\r?\n<\/content>(?=\r?\n|$)/.exec(body);
  return envelope ? envelope[1]! + body.slice(envelope[0].length) : output;
}

function dynamicOutput(output: string, content: unknown): JsonValue {
  if (!Array.isArray(content)) return output;
  const images = content.flatMap((part) => {
    if (!record(part) || part.type !== "file" || typeof part.uri !== "string") return [];
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(part.uri);
    return match ? [{ type: "image", mimeType: match[1]!, data: match[2]! }] : [];
  }).slice(0, 8);
  return images.length ? [...(output ? [{ type: "text", text: output }] : []), ...images] : output;
}

/** Project a terminal provider event. Invalid or mismatched events return undefined. */
export function projectToolCompletion(event: Completion, context: ToolProjectionContext): EngineEvent[] | undefined {
  if (!record(event) || !record(event.data) || (event.type !== "session.tool.success" && event.type !== "session.tool.failed") ||
    !context.turnId || !context.sessionId || !context.assistantMessageId || !context.toolId || !context.name ||
    event.data.id !== context.toolId || event.data.sessionID !== context.sessionId || event.data.assistantMessageID !== context.assistantMessageId ||
    typeof event.data.executed !== "boolean" || !record(context.input) || !isJson(context.input)) return undefined;
  const success = event.type === "session.tool.success";
  const content = success ? event.data.content : undefined;
  const output = success ? textOf(content) : record(event.data.error) && typeof event.data.error.message === "string" && typeof event.data.error.type === "string" ? event.data.error.message : undefined;
  if (output === undefined || (event.data.metadata !== undefined && (!record(event.data.metadata) || !isJson(event.data.metadata)))) return undefined;
  const metadata = event.data.metadata;
  const input = context.input;
  const name = context.name;
  const normalized = name.toLowerCase();
  const mcp = name.startsWith("mcp__") || name.startsWith("goat_");
  const command = !mcp && (normalized.includes("bash") || normalized.includes("shell"));
  const exit = success && command ? number(metadata, "exit", "exitCode") : undefined;
  const status = !success ? (event.data.error.type === "aborted" ? "interrupted" : "failed") : exit !== undefined && exit !== 0 ? "failed" : "completed";
  const base = { id: context.toolId, nativeId: context.toolId, turnId: context.turnId, driver: "opencode", now: context.now, startedAt: context.startedAt ?? null, title: context.title ?? null, status } as const;
  let projected: HelperItem;
  if (name === "subagent") {
    const sub = context.subagent;
    if (!sub || !sub.id || !sub.instanceId || typeof input.prompt !== "string") return undefined;
    if (success && metadata?.status === "running") return [{ type: "subagent_update", turnId: context.turnId, subagentId: sub.id, status: "running", title: string(input, "description") ?? context.title ?? null, progress: null }];
    const result = success ? (/^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(output.trim())?.[1] ?? output) : output;
    projected = item({ ...base, title: string(input, "description") ?? context.title ?? null }, "subagent", { subagentId: sub.id, origin: "provider_native", driver: "opencode", providerInstanceId: sub.instanceId, childThreadId: sub.childThreadId, prompt: input.prompt, result });
  } else {
    const todo = name === "todowrite" && success ? projectTodoList(metadata, context) : undefined;
    if (todo) projected = todo;
    else if (command) projected = item(base, "command_execution", { input: string(input, "command", "cmd") ?? JSON.stringify(input, null, 2), output, ...(exit === undefined ? {} : { exitCode: exit }) });
    else if (!mcp && normalized !== "todowrite" && (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch"))) {
      const diff = (success ? string(metadata, "diff", "patch") : undefined) ?? (status === "failed" && output.trim() ? output : undefined);
      projected = item(base, "file_change", { fileName: string(input, "filePath", "path", "file") ?? name, ...(diff === undefined ? {} : { diffStr: diff }) });
    } else if (!mcp && (normalized.includes("web") || normalized === "codesearch" || normalized === "code_search")) {
      const pattern = string(input, "query", "url", "pattern");
      const url = string(input, "url")?.trim();
      projected = item(base, "web_search", { ...(pattern === undefined ? {} : { patterns: [pattern] }), ...(output.trim() ? { results: [{ ...(url === undefined ? {} : { url }), snippet: output.slice(0, 8000) }] } : {}) });
    } else projected = item(base, "dynamic_tool", { toolName: name, input, output: dynamicOutput(name === "read" ? readOutput(output) : output, content) });
  }
  return [{ type: "item_completed", turnId: context.turnId, item: projected, locator: null }];
}
