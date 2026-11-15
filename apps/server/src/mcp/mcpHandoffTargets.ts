import type { McpSchema } from "effect/ai";

import { toolOutcome } from "../telemetry/ProviderDimensions.ts";

/**
 * Tools that hand work to another thread's agent: they create it, message it,
 * steer it, or move context into it. Their events name the receiving agent too.
 */
export const HANDOFF_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "goat_thread_launch",
  "goat_thread_send",
  "goat_thread_send_attachments",
  "goat_thread_fork",
  "goat_thread_merge_back",
  "goat_queue_edit",
  "goat_queue_promote_to_steer",
  "goat_pending_request_respond",
  "schedule_task",
  "run_scheduled_task_now",
]);

/** Handoff tools whose result is only `{ sequence }`; their input names the receiving thread. */
const INPUT_TARGET_TOOLS: ReadonlySet<string> = new Set([
  "goat_queue_edit",
  "goat_queue_promote_to_steer",
  "goat_pending_request_respond",
]);

const resultThreadKeys = ["childThreadId", "targetThreadId", "boundThreadId", "threadId"] as const;

/** Thread ids a handoff tool result names: the thread that received the work. */
const resultThreadIds = (content: unknown): ReadonlyArray<string> => {
  if (typeof content !== "object" || content === null) return [];
  const record = content as Readonly<Record<string, unknown>>;
  if (Array.isArray(record.threads)) return record.threads.flatMap(resultThreadIds);
  const key = resultThreadKeys.find((candidate) => typeof record[candidate] === "string");
  return key === undefined ? [] : [record[key] as string];
};

/**
 * Thread ids that received a handoff. The input's `threadId` is used only after
 * the call succeeded, so it is one the handler already resolved and authorized.
 */
export const handoffTargetIds = (
  tool: string,
  args: unknown,
  result: McpSchema.CallToolResult | undefined,
): ReadonlyArray<string> => {
  if (!INPUT_TARGET_TOOLS.has(tool)) return resultThreadIds(result?.structuredContent);
  if (result === undefined || toolOutcome(result).outcome !== "ok") return [];
  const threadId = (args as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? [threadId] : [];
};
