// @effect-diagnostics nodeBuiltinImport:off -- byteLength counts UTF-8 without copying a string.
import * as NodeBuffer from "node:buffer";
import type { OrchestrationV2ConversationMessage, ThreadId } from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import type * as EffectAcpSchema from "effect-acp/compat";
import { acpContentBlockDisplayText } from "./runtimeModel.ts";

const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 200;
type HistoryRole = "user" | "assistant" | "thought";

interface SnapshotMessageState {
  readonly order: Array<string>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly reasoningIds: Set<OrchestrationV2ConversationMessage["id"]>;
  readonly messageBytes: Map<string, number>;
  retainedBytes: number;
  limitExceeded: boolean;
  loadingRole: HistoryRole | null;
  loadingMessageId: string | null;
  loadingIndex: number;
}

export const emptySnapshotState = (): SnapshotMessageState => ({
  order: [],
  messages: new Map(),
  reasoningIds: new Set(),
  messageBytes: new Map(),
  retainedBytes: 0,
  limitExceeded: false,
  loadingRole: null,
  loadingMessageId: null,
  loadingIndex: 0,
});

function replayText(
  content: string | ReadonlyArray<EffectAcpSchema.ContentBlock>,
  byteLimit: number | undefined,
): { readonly text: string; readonly bytes: number } | undefined {
  if (typeof content === "string") {
    const bytes = byteLimit === undefined ? 0 : NodeBuffer.Buffer.byteLength(content);
    return byteLimit !== undefined && bytes > byteLimit ? undefined : { text: content, bytes };
  }
  const parts: string[] = [];
  let bytes = 0;
  for (const block of content) {
    const part = acpContentBlockDisplayText(block);
    if (part === undefined) continue;
    if (byteLimit !== undefined) {
      bytes += NodeBuffer.Buffer.byteLength(part) + (parts.length === 0 ? 0 : 1);
      if (bytes > byteLimit) return undefined;
    }
    parts.push(part);
  }
  return { text: parts.join("\n"), bytes };
}

export function appendLoadedSnapshotMessage(
  state: SnapshotMessageState,
  notification: EffectAcpSchema.SessionNotification,
  role: HistoryRole,
  content: string | ReadonlyArray<EffectAcpSchema.ContentBlock>,
  replace: boolean,
  threadId: ThreadId,
  now: DateTime.Utc,
  providerMessageId: (id: string) => OrchestrationV2ConversationMessage["id"],
  limited: boolean,
): SnapshotMessageState {
  if (state.limitExceeded) return state;
  const update = notification.update;
  const sourceMessageId =
    (update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk" ||
      update.sessionUpdate === "user_message" ||
      update.sessionUpdate === "agent_message" ||
      update.sessionUpdate === "agent_thought") &&
    update.messageId
      ? update.messageId
      : null;
  const startsNew =
    state.loadingRole !== role ||
    (sourceMessageId !== null && state.loadingMessageId !== sourceMessageId);
  const loadingIndex = startsNew ? state.loadingIndex + 1 : state.loadingIndex;
  const nativeItemId =
    sourceMessageId === null
      ? `${notification.sessionId}:history:${role}:${loadingIndex}`
      : `${notification.sessionId}:history:${role}:message:${sourceMessageId}`;
  const id = providerMessageId(nativeItemId);
  const previous = state.messages.get(id);
  const before = state.messageBytes.get(id) ?? 0;
  if (limited && previous === undefined && state.messages.size >= MAX_HISTORY_MESSAGES)
    return { ...emptySnapshotState(), limitExceeded: true };
  const byteLimit = limited
    ? MAX_HISTORY_BYTES - state.retainedBytes + (replace ? before : 0)
    : undefined;
  const replayed = replayText(content, byteLimit);
  if (replayed === undefined) return { ...emptySnapshotState(), limitExceeded: true };
  if (limited) {
    state.messageBytes.set(id, replace ? replayed.bytes : before + replayed.bytes);
    state.retainedBytes += replayed.bytes - (replace ? before : 0);
  }
  if (previous === undefined) state.order.push(id);
  state.messages.set(id, {
    createdBy: previous?.createdBy ?? (role === "user" ? "user" : "agent"),
    creationSource: previous?.creationSource ?? "provider",
    id,
    threadId,
    runId: null,
    nodeId: null,
    role: role === "user" ? "user" : "assistant",
    text: replace ? replayed.text : `${previous?.text ?? ""}${replayed.text}`,
    attachments: [],
    streaming: false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  });
  if (role === "thought") state.reasoningIds.add(id);
  state.loadingRole = role;
  state.loadingMessageId = sourceMessageId ?? (startsNew ? null : state.loadingMessageId);
  state.loadingIndex = loadingIndex;
  return state;
}
