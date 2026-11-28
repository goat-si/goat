import type { OrchestrationV2TurnItem } from "@goat/contracts";

const PR_THREAD_COMMAND_OUTPUT_CHARS = 2_000;

export function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

// Preserve command evidence when selectHistory drops oversized items; test verdicts are at the tail.
export function limitCommandOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" || item.output === undefined) return item;
  if (item.output.length <= PR_THREAD_COMMAND_OUTPUT_CHARS) return item;
  const tail = item.output.slice(-PR_THREAD_COMMAND_OUTPUT_CHARS).replace(/^[\uDC00-\uDFFF]/u, "");
  return { ...item, output: `[truncated]\n${tail}` };
}
