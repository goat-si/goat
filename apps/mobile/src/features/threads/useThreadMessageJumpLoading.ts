import type { MessageId } from "@goat/contracts";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import type { ThreadFeedHistoryControls } from "./ThreadFeed";
import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  subscribeThreadMessageJump,
} from "./threadMessageJump";

/**
 * A palette message result opens the thread at that message: earlier history loads until the
 * message is in the feed, which then scrolls to it.
 */
export function useThreadMessageJumpLoading(input: {
  readonly threadKey: string;
  readonly feed: ReadonlyArray<{ readonly type: string; readonly id: string }>;
  readonly ready: boolean;
  readonly history: ThreadFeedHistoryControls | undefined;
}): { readonly jumpMessageId: MessageId | null; readonly jumpMessageLoaded: boolean } {
  const { threadKey, history } = input;
  const jumpMessageId: MessageId | null = useSyncExternalStore(subscribeThreadMessageJump, () =>
    pendingThreadMessageJump(threadKey),
  );
  const jumpMessageLoaded =
    jumpMessageId !== null &&
    input.feed.some((entry) => entry.type === "message" && entry.id === jumpMessageId);
  // History down to the message in one request; another page if it is not there yet.
  const loadEarlierForJump = useEffectEvent(() => {
    if (jumpMessageId !== null) history?.onLoadThrough(jumpMessageId);
  });
  const ready = input.ready;
  // oxlint-disable-next-line goat/react-effect-budget -- Loads history until the jump's message is in the feed, then ends the jump.
  useEffect(() => {
    if (jumpMessageId === null || jumpMessageLoaded || !ready) return;
    if (history?.loading) return;
    if (!history?.hasMoreHistory || history.error !== null) {
      finishThreadMessageJump(threadKey);
      return;
    }
    loadEarlierForJump();
  }, [
    ready,
    history?.error,
    history?.hasMoreHistory,
    history?.loading,
    jumpMessageId,
    jumpMessageLoaded,
    threadKey,
  ]);
  return { jumpMessageId, jumpMessageLoaded };
}
