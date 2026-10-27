import { resolveGoatMcpItemCall } from "@goat/shared/goatMcpToolPresentation";

import type { WorkLogEntry } from "../../session-logic";

/** A goat tool call that started or messaged other threads, read from its arguments and result. */
export interface GoatThreadCall {
  readonly kind: "launch" | "create_many" | "ssh_launch" | "send";
  readonly entryId: string;
  readonly runId: string | null;
  /** The threads the call reached, in result order. */
  readonly threadIds: readonly string[];
  /** thread.send: the message it delivered. */
  readonly messageId: string | null;
  /** ssh.thread_launch, or a send to another machine. */
  readonly host: string | null;
  readonly title: string | null;
}

const KIND_BY_TOOL: Record<string, GoatThreadCall["kind"]> = {
  goat_thread_launch: "launch",
  create_threads: "create_many",
  goat_thread_create_many: "create_many",
  goat_ssh_thread_launch: "ssh_launch",
  goat_thread_send: "send",
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

// Tool results arrive as the value itself, an MCP envelope, or JSON text inside one.
function resultValue(output: unknown): unknown {
  if (typeof output === "string") {
    try {
      return resultValue(JSON.parse(output));
    } catch {
      return null;
    }
  }
  if (!isRecord(output)) return output;
  if (isRecord(output.structuredContent)) return resultValue(output.structuredContent);
  if (output.status === "ok" && "value" in output) return resultValue(output.value);
  if (Array.isArray(output.content)) {
    const first: unknown = output.content[0];
    return isRecord(first) ? resultValue(first.text) : null;
  }
  return output;
}

function toolKind(toolName: string | null | undefined): GoatThreadCall["kind"] | null {
  const name = toolName?.split(/[./]|__/).at(-1);
  return name === undefined ? null : (KIND_BY_TOOL[name] ?? null);
}

/** The thread call a work entry made, or null when it is another tool or has no result yet. */
export function goatThreadCallOf(entry: WorkLogEntry): GoatThreadCall | null {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool" || item.status !== "completed") return null;
  const call = resolveGoatMcpItemCall(item);
  const kind = toolKind(call.toolName);
  if (kind === null) return null;
  const args = isRecord(call.input) ? call.input : {};
  const result = resultValue(item.output);
  const records = isRecord(result)
    ? Array.isArray(result.threads)
      ? result.threads.filter(isRecord)
      : [result]
    : [];
  const threadIds = records.flatMap((record) => {
    const id =
      text(record.threadId) ?? (isRecord(record.thread) ? text(record.thread.threadId) : null);
    return id === null ? [] : [id];
  });
  if (threadIds.length === 0) return null;
  const first = records[0] ?? {};
  return {
    kind,
    entryId: entry.id,
    runId: entry.runId ?? null,
    threadIds,
    messageId: kind === "send" ? text(first.messageId) : null,
    host: text(first.host) ?? text(args.host),
    title: text(args.title) ?? text(first.title),
  };
}
