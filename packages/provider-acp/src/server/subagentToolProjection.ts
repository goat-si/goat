import type { OrchestrationV2ExecutionNode, ProviderRequestKind } from "@goat/contracts";
import type { DateTime } from "effect";
import type { AcpToolCallState } from "./runtimeModel.ts";
import { unknownRecord } from "./clientPolicy.ts";

export type ProjectedToolStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export function nodeStatus(status: ProjectedToolStatus): OrchestrationV2ExecutionNode["status"] {
  return status === "pending" ? "running" : status;
}

export function completedAtForStatus(
  status: ProjectedToolStatus,
  now: DateTime.Utc,
): DateTime.Utc | null {
  return status === "completed" || status === "failed" || status === "interrupted" ? now : null;
}

// Copilot advertises URL ids such as `https://agentclientprotocol.com/protocol/session-modes#plan`.
export function isAcpPlanModeId(id: string): boolean {
  const name = id.slice(id.lastIndexOf("#") + 1);
  return name === "plan" || name === "architect";
}

// Some agents answer Stop's `session/cancel` by failing the tools that were
// running (Kiro: "Tool execution was cancelled by the user."). After Stop, a
// failure is shown as the interruption it was.
export function stoppedToolStatus(
  turn: { readonly interrupted: boolean },
  tool: AcpToolCallState,
): "interrupted" | undefined {
  return turn.interrupted && tool.status === "failed" ? "interrupted" : undefined;
}

// Append a streamed text chunk to the last content entry so repeated chunks
// merge into one text entry instead of a new entry per chunk.
export function appendToolCallContentChunk(previousContent: unknown, text: string): Array<unknown> {
  const content: unknown[] = Array.isArray(previousContent) ? [...previousContent] : [];
  const last = unknownRecord(content.at(-1));
  const lastContent = unknownRecord(last?.content);
  if (
    last?.type === "content" &&
    lastContent?.type === "text" &&
    typeof lastContent.text === "string"
  ) {
    content[content.length - 1] = {
      ...last,
      content: { ...lastContent, text: `${lastContent.text}${text}` },
    };
  } else {
    content.push({ type: "content", content: { type: "text", text } });
  }
  return content;
}

// Remember forced interruptions so late updates keep showing `interrupted`.
export function applyInterruptedToolStatus(
  interruptedToolIds: Set<string>,
  key: string,
  mergedStatus: AcpToolCallState["status"],
  projectedStatus: ProjectedToolStatus | undefined,
): ProjectedToolStatus | undefined {
  if (mergedStatus !== "failed") interruptedToolIds.delete(key);
  if (projectedStatus === "interrupted") interruptedToolIds.add(key);
  return mergedStatus === "failed" && interruptedToolIds.has(key) ? "interrupted" : projectedStatus;
}

export function toolStatus(
  status: AcpToolCallState["status"],
): "pending" | "running" | "waiting" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "requiresAction":
      return "waiting";
    default:
      return "running";
  }
}

export function providerRequestKind(kind: string | "unknown"): ProviderRequestKind {
  switch (kind) {
    case "execute":
      return "command";
    case "read":
    case "search":
    case "fetch":
      return "file-read";
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    default:
      return "command";
  }
}
