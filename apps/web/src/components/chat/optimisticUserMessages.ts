import type { MessageId } from "@goat/contracts";
import type { SetStateAction } from "react";
import type { ChatMessage } from "../../types";
import { collectUserMessageBlobPreviewUrls } from "../ChatView.logic";

// Acknowledged rows stay retired even if the server later removes them; their blobs live in handoff.
export interface OptimisticUserMessages {
  readonly threadKey: string;
  readonly messages: ChatMessage[];
  readonly handoff: Readonly<Record<string, ReadonlyArray<string>>>;
}

export function emptyOptimisticUserMessages(threadKey: string): OptimisticUserMessages {
  return { threadKey, messages: [], handoff: {} };
}

export function reconcileOptimisticUserMessages(
  state: OptimisticUserMessages,
  threadKey: string,
  acknowledgedIds: ReadonlySet<MessageId>,
): OptimisticUserMessages {
  if (state.threadKey !== threadKey) return emptyOptimisticUserMessages(threadKey);
  if (!state.messages.some((message) => acknowledgedIds.has(message.id))) return state;
  const messages: ChatMessage[] = [];
  const handoff: Record<string, ReadonlyArray<string>> = { ...state.handoff };
  for (const message of state.messages) {
    if (!acknowledgedIds.has(message.id)) {
      messages.push(message);
      continue;
    }
    const previewUrls = collectUserMessageBlobPreviewUrls(message);
    if (previewUrls.length > 0) handoff[message.id] = previewUrls;
  }
  return { ...state, messages, handoff };
}

/** Applies a send-path update. An update for a thread the view has since left is dropped. */
export function applyOptimisticUserMessagesAction(
  state: OptimisticUserMessages,
  threadKey: string,
  action: SetStateAction<ChatMessage[]>,
): OptimisticUserMessages {
  if (state.threadKey !== threadKey) return state;
  const next = typeof action === "function" ? action(state.messages) : action;
  const unchanged =
    next.length === state.messages.length &&
    next.every((message, index) => message === state.messages[index]);
  return unchanged ? state : { ...state, messages: next };
}

export function dropOptimisticHandoff(
  state: OptimisticUserMessages,
  threadKey: string,
  messageId: MessageId,
): OptimisticUserMessages {
  if (state.threadKey !== threadKey || !(messageId in state.handoff)) return state;
  const { [messageId]: _released, ...handoff } = state.handoff;
  return { ...state, handoff };
}

// A failure after acknowledgement must leave the server row's blob preview owned by its handoff.
export interface OptimisticBlobPreviews {
  readonly track: (threadKey: string, message: ChatMessage) => void;
  readonly handOff: (state: OptimisticUserMessages) => void;
  readonly revoke: (threadKey: string, previewUrls: ReadonlyArray<string>) => void;
  readonly release: (threadKey: string, message: ChatMessage) => void;
  readonly revokeThread: (threadKey: string) => void;
}

export function createOptimisticBlobPreviews(): OptimisticBlobPreviews {
  const ownedByThread = new Map<string, Set<string>>();
  const handedOff = new Set<string>();
  const revoke = (threadKey: string, previewUrls: ReadonlyArray<string>) => {
    const owned = ownedByThread.get(threadKey);
    for (const previewUrl of previewUrls) {
      owned?.delete(previewUrl);
      handedOff.delete(previewUrl);
      if (typeof URL !== "undefined") URL.revokeObjectURL(previewUrl);
    }
  };
  return {
    track: (threadKey, message) => {
      const previewUrls = collectUserMessageBlobPreviewUrls(message);
      if (previewUrls.length === 0) return;
      const owned = ownedByThread.get(threadKey) ?? new Set<string>();
      for (const previewUrl of previewUrls) owned.add(previewUrl);
      ownedByThread.set(threadKey, owned);
    },
    handOff: (state) => {
      for (const previewUrls of Object.values(state.handoff)) {
        for (const previewUrl of previewUrls) handedOff.add(previewUrl);
      }
    },
    revoke,
    release: (threadKey, message) =>
      revoke(
        threadKey,
        collectUserMessageBlobPreviewUrls(message).filter((url) => !handedOff.has(url)),
      ),
    revokeThread: (threadKey) => {
      revoke(threadKey, [...(ownedByThread.get(threadKey) ?? [])]);
      ownedByThread.delete(threadKey);
    },
  };
}
